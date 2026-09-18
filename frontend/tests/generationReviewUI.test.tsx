// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { GenerationCard } from "../src/components/GenerationCard";
import { LibraryToolbar } from "../src/components/LibraryToolbar";
import { LibrarySelectionActionBar } from "../src/components/app/SelectionActionBar";
import { HistoryBoardNode } from "../src/components/history/HistoryBoardNode";
import { GenerationReviewOverlay } from "../src/components/generation/GenerationReviewOverlay";
import { setLang } from "../src/lib/i18n";
import { useLibraryFilters } from "../src/lib/useLibraryFilters";
import { useGenerationCardActions } from "../src/lib/useGenerationCardActions";
import { makeStore } from "../src/lib/storage";
import { api } from "../src/api";
import type { Generation } from "../src/types";

vi.mock("../src/lib/modelCatalog", () => ({ useModelDisplayName: () => () => "Test model" }));
vi.mock("../src/lib/modelPolicy", () => ({ modelBlockMessage: () => null }));
vi.mock("../src/lib/libraryBroadcast", () => ({ postLibraryChanged: vi.fn() }));
vi.mock("../src/api", () => ({ api: { setReviewState: vi.fn() } }));
const noop = () => {};

it("open review menu never lets a double event run a bulk grade action behind it", () => {
  const p = { ...props(gen({ shared: false })), selected: true, selectedCount: 2,
    onBulkGradeStep: vi.fn(), onBulkReview: vi.fn() };
  act(() => root.render(<GenerationCard {...p} />));
  click(".card-sf");
  // CSS가 S를 가리는 현재 배치에 기대지 않고 핸들러 자체가 확인 단계를 지키는지 검사.
  act(() => host.querySelector(".card-sf")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, detail: 2 })));
  expect(p.onBulkGradeStep).not.toHaveBeenCalled();
  expect(p.onBulkReview).not.toHaveBeenCalled();
  expect(host.querySelectorAll(".review-option")).toHaveLength(3);
});

it.each(["single", "double"] as const)("Workspace %s keeps the existing confirmation flow", (kind) => {
  vi.useFakeTimers();
  const p = props();
  act(() => root.render(<GenerationCard {...p} tab="my" />));
  const button = host.querySelector(".card-sf")!;
  act(() => button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
  if (kind === "double") {
    act(() => {
      vi.advanceTimersByTime(60);
      button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2 }));
      button.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, detail: 2 }));
    });
  }
  act(() => vi.advanceTimersByTime(220));
  expect(host.querySelector(".review-confirm")).toBeNull();
  expect(host.querySelector(".cs-final-q")?.textContent).toBe(kind === "single"
    ? "공유 해제 할까요?" : "최종(골드)으로 지정할까요?");
  expect(p.onUnpublish).not.toHaveBeenCalled(); expect(p.onFinalize).not.toHaveBeenCalled();
  click(".cs-final-yes");
  expect(kind === "single" ? p.onUnpublish : p.onFinalize).toHaveBeenCalledExactlyOnceWith(p.gen);
  expect(kind === "single" ? p.onFinalize : p.onUnpublish).not.toHaveBeenCalled();
});

it.each(["grid", "list"] as const)("%s: rapid second pointer click stays in review menu until an intentional choice", (layout) => {
  let now = 1000;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
  const pointerClick = (selector: string, detail = 1) => act(() => {
    host.querySelector(selector)!.dispatchEvent(new MouseEvent("click", { bubbles: true, detail }));
  });
  try {
    const p = props();
    act(() => root.render(<GenerationCard {...p} layout={layout} />));
    pointerClick(".card-sf");
    expect(host.querySelectorAll(".review-option")).toHaveLength(3);
    for (const detail of [1, 2]) {
      now = 1060;
      pointerClick(".review-unshared", detail);
      expect(host.querySelectorAll(".review-option")).toHaveLength(3);
      expect(host.querySelector(".cs-final-q")).toBeNull();
    }
    expect(p.onReview).not.toHaveBeenCalled();
    expect(p.onUnpublish).not.toHaveBeenCalled();
    expect(p.onFinalize).not.toHaveBeenCalled();
    now = 1220;
    pointerClick(".review-held");
    expect(host.querySelector(".cs-final-q")?.textContent).toBe("보류할까요?");
    expect(p.onReview).not.toHaveBeenCalled();
    pointerClick(".cs-final-yes");
    expect(p.onReview).toHaveBeenCalledExactlyOnceWith(p.gen, "held");
  } finally { clock.mockRestore(); }
});

it("review keyboard activation is immediate and Escape/reopen restarts only the pointer guard", () => {
  let now = 1000;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
  try {
    const p = props();
    act(() => root.render(<GenerationCard {...p} />));
    click(".card-sf");
    // Keyboard/programmatic activation has detail=0, so it must not inherit pointer suppression.
    click(".review-final");
    expect(host.querySelector(".cs-final-q")?.textContent).toBe("최종(골드)으로 지정할까요?");
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(host.querySelector(".review-confirm")).toBeNull();
    now = 5000;
    click(".card-sf");
    act(() => host.querySelector(".review-held")!.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
    expect(host.querySelector(".cs-final-q")).toBeNull();
    click(".review-held"); click(".cs-final-yes");
    expect(p.onReview).toHaveBeenCalledExactlyOnceWith(p.gen, "held");
    expect(p.onFinalize).not.toHaveBeenCalled();
  } finally { clock.mockRestore(); }
});

const gen = (patch: Partial<Generation> = {}) => ({
  id: "g", prompt: "test", display_prompt: null, status: "done", created_at: "2026-09-17",
  shared: true, is_held: false, is_final: false, is_mine: true, deleted: false,
  tags: [], auto_tags: [], assets: [], references: [], comment_count: 0, ...patch,
} as Generation);
function props(generation = gen()): ComponentProps<typeof GenerationCard> {
  return { gen: generation, tab: "team", onSetSource: noop, onSetTags: noop, onOpenComments: noop,
    onRequestEdit: noop, onEditDone: noop, onRegenerate: noop, onPublish: vi.fn(), onUnpublish: vi.fn(),
    onFinalize: vi.fn(), onUnfinalize: vi.fn(), onReview: vi.fn(),
    onImport: noop, onRestore: noop, onInfo: noop, onPreview: noop,
  };
}
function toolbarProps(): ComponentProps<typeof LibraryToolbar> {
  return { typeFilter: "all", onTypeFilter: noop, scale: 1, onScale: noop, fill: true, onToggleFill: noop,
    layout: "grid", onLayout: noop, groupByDate: false, onToggleGroupByDate: noop,
    filtersOpen: false, onToggleFilters: noop, count: 0, loading: false, failedCount: 0, onClearFailed: noop,
    colorDots: [], colorFilter: new Set(), onToggleColor: noop, sharedOnly: true, onToggleShared: vi.fn(),
    reviewFilter: "shared", onReviewFilter: vi.fn(), commentOnly: false, onToggleComment: noop,
    hasUnread: false, tags: [], tagFilter: new Set(), onSelectTag: noop, onDeleteTag: noop,
    onClearTags: noop, tagPanelOpen: false, onToggleTagPanel: noop };
}
let root: Root;
let host: HTMLDivElement;
function click(selector: string) { act(() => host.querySelector<HTMLButtonElement>(selector)!.click()); }
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear(); setLang("ko");
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); setLang("ko"); vi.useRealTimers(); vi.unstubAllGlobals(); });

it.each(["grid", "list"] as const)("%s: shared S opens immediate menu then Yes/No; No exits without mutation", (layout) => {
  const p = props();
  act(() => root.render(<GenerationCard {...p} layout={layout} />));
  click(".card-sf");
  expect([...host.querySelectorAll(".review-option-name")].map((button) => button.textContent)).toEqual(["−해제", "S보류", "★최종"]);
  expect(host.querySelector(".review-cancel")).toBeNull();
  click(".review-unshared");
  expect(host.querySelector(".cs-final-q")?.textContent).toBe("공유 해제 할까요?");
  expect(p.onReview).not.toHaveBeenCalled();
  click(".cs-final-no");
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  expect(p.onUnpublish).not.toHaveBeenCalled(); expect(p.onReview).not.toHaveBeenCalled();
  click(".card-sf"); click(".review-held"); click(".cs-final-yes");
  expect(p.onReview).toHaveBeenCalledWith(p.gen, "held"); expect(p.onUnpublish).not.toHaveBeenCalled();
});

it("held shows a red S without changing card border, return/finalize use exact actions", () => {
  const p = props(gen({ is_held: true }));
  act(() => root.render(<GenerationCard {...p} />));
  expect(host.querySelector(".card-sf.held")?.textContent).toBe("S");
  expect(host.querySelector(".card")?.classList.contains("held")).toBe(false);
  click(".card-sf");
  expect([...host.querySelectorAll(".review-option-name")].map((button) => button.textContent)).toEqual(["−해제", "S공유", "★최종"]);
  click(".review-shared"); click(".cs-final-yes"); expect(p.onReview).toHaveBeenCalledWith(p.gen, "shared");
  click(".card-sf"); click(".review-final"); click(".cs-final-yes"); expect(p.onReview).toHaveBeenCalledWith(p.gen, "final");
});

it("multi-selection S never runs unpublish and uses actual allowed operations", () => {
  const p = { ...props(), selected: true, selectedCount: 4, onBulkGradeStep: vi.fn(), onBulkReview: vi.fn(),
    bulkReviewAllowed: { unshared: true, shared: true, held: false, final: true } };
  act(() => root.render(<GenerationCard {...p} />)); click(".card-sf");
  expect(host.textContent).toContain("선택 4개에 적용");
  expect(host.querySelector<HTMLButtonElement>(".review-held")!.disabled).toBe(true);
  click(".review-final"); expect(p.onBulkReview).not.toHaveBeenCalled();
  click(".cs-final-yes"); expect(p.onBulkReview).toHaveBeenCalledWith("final");
  expect(p.onBulkGradeStep).not.toHaveBeenCalled(); expect(p.onUnpublish).not.toHaveBeenCalled();
});

it("permission denied disables review actions; gold opens all three alternatives with single click", () => {
  vi.useFakeTimers();
  const p = props(gen({ is_held: true, is_mine: false }));
  act(() => root.render(<GenerationCard {...p} canFinalize={() => false} />)); click(".card-sf");
  expect(host.querySelector<HTMLButtonElement>(".review-shared")!.disabled).toBe(true);
  expect(host.querySelector<HTMLButtonElement>(".review-final")!.disabled).toBe(true);
  const finalProps = props(gen({ is_final: true }));
  act(() => root.render(<GenerationCard {...finalProps} />)); click(".card-sf");
  expect([...host.querySelectorAll(".review-option-name")].map((button) => button.textContent)).toEqual(["−해제", "S공유", "S보류"]);
  click(".review-held"); expect(finalProps.onReview).not.toHaveBeenCalled();
  click(".cs-final-yes"); expect(finalProps.onReview).toHaveBeenCalledWith(finalProps.gen, "held");
  expect(finalProps.onUnfinalize).not.toHaveBeenCalled();
});

it("English review labels use the i18n dictionary", () => {
  setLang("en"); act(() => root.render(<GenerationCard {...props(gen({ is_held: true }))} />)); click(".card-sf");
  expect(host.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("What would you like to do with this result?");
  expect(host.querySelector(".review-shared .review-option-label")?.textContent).toBe("Shared");
  expect(host.querySelector(".review-option-detail")).toBeNull();
  click(".review-shared"); expect(host.textContent).toContain("Return to shared?");
  expect(host.querySelector(".cs-final-no")?.textContent).toBe("No");
});

it("outside click and Escape close both selection and confirmation without changing data", () => {
  const p = props(); act(() => root.render(<GenerationCard {...p} />));
  click(".card-sf"); act(() => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));
  expect(host.querySelector(".review-confirm")).toBeNull();
  click(".card-sf"); click(".review-held");
  act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(host.querySelector(".review-confirm")).toBeNull(); expect(p.onReview).not.toHaveBeenCalled();
});

it("Yes repeated before rerender emits one transition and compact menu stays within its panel", () => {
  const onAction = vi.fn();
  const css = readFileSync(new NodeURL("../src/styles/generations.css", import.meta.url), "utf8");
  act(() => root.render(<><style>{css}</style><div style={{ width: 140, height: 110, position: "relative" }}>
    <GenerationReviewOverlay state="shared" allowed={{ unshared: true, shared: false, held: true, final: true }}
      onAction={onAction} onCancel={noop} /></div></>));
  const panelStyle = getComputedStyle(host.querySelector(".review-panel")!);
  expect(panelStyle.maxHeight).toBe("100%"); expect(panelStyle.overflowY).toBe("auto");
  expect(getComputedStyle(host.querySelector(".review-options")!).display).toBe("grid");
  expect(host.querySelector(".review-option-detail")).toBeNull();
  expect(getComputedStyle(host.querySelector(".review-option")!).minHeight).toBe("30px");
  expect(getComputedStyle(host.querySelector(".review-option-label")!).whiteSpace).toBe("nowrap");
  expect(getComputedStyle(host.querySelector(".review-option-label")!).textOverflow).toBe("ellipsis");
  click(".review-unshared");
  const yes = host.querySelector<HTMLButtonElement>(".cs-final-yes")!;
  act(() => { yes.click(); yes.click(); });
  expect(onAction).toHaveBeenCalledTimes(1); expect(onAction).toHaveBeenCalledWith("unshared");
});

it.each(["shared", "held"] as const)("toolbar %s right click offers exactly one opposite S below", (filter) => {
  const p = { ...toolbarProps(), reviewFilter: filter };
  const assetStyles = readFileSync(new NodeURL("../src/styles/assets.css", import.meta.url), "utf8");
  act(() => root.render(<><style>{assetStyles}</style><LibraryToolbar {...p} /></>));
  const main = host.querySelector<HTMLButtonElement>(".lib-review-filter > button")!;
  act(() => main.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
  const alternate = host.querySelector<HTMLButtonElement>(".lib-review-alternative")!;
  expect(host.querySelectorAll(".lib-review-filter button")).toHaveLength(2);
  expect(alternate.textContent).toBe("S");
  expect(alternate.classList.contains("held")).toBe(filter === "shared");
  expect(getComputedStyle(alternate).left).toBe("50%");
  expect(getComputedStyle(alternate).top).toBe("calc(100% + 6px)");
  expect(getComputedStyle(alternate).transform).toBe("translateX(-50%)");
  click(".lib-review-alternative");
  expect(p.onReviewFilter).toHaveBeenCalledWith(filter === "shared" ? "held" : "shared");
  expect(p.onToggleShared).not.toHaveBeenCalled();
  click(".lib-review-filter > button"); expect(p.onToggleShared).toHaveBeenCalledTimes(1);
});

it("held mode is persisted in account-scoped store and Resolve disables only the active toggle", () => {
  const store = makeStore("review-account-a.");
  let state!: ReturnType<typeof useLibraryFilters>;
  function Harness() { state = useLibraryFilters(store, { scope: "team", id: "ws-a", name: "A" }); return null; }
  act(() => root.render(<Harness />));
  act(() => { state.patch({ tab: "team" }); state.setReviewFilter("held"); state.setSharedOnly(true); });
  expect(state.genQuery.review_filter).toBe("held"); expect(state.genQuery.workspace_ids).toEqual(["ws-a"]);
  expect(state.genQuery.shared_only).toBeUndefined(); expect(store.get("reviewFilter")).toBe("held");
  act(() => state.followLocation({ project_id: "p", folder_path: "shots" }));
  expect(state.sharedOnly).toBe(false); expect(state.reviewFilter).toBe("held");
  expect(state.genQuery.review_filter).toBeUndefined();
  expect(makeStore("review-account-b.").get("reviewFilter", "shared")).toBe("shared");
});

it("history/canvas shared node uses held badge and selected review mode", () => {
  act(() => root.render(<HistoryBoardNode generation={gen({ is_held: true })} x={0} y={0} width={180} height={180}
    isRoot={false} isSelected={false} onLine={false} offLine={false} fill disabled={false} typeFilter="all"
    sharedOnly reviewFilter="shared" commentOnly={false} finalOnly={false} sConfirm={null}
    onSClick={noop} onSDouble={noop} onSConfirmYes={noop} onSConfirmNo={noop} onPreview={noop} onInfo={noop} onRegenerate={noop} />));
  expect(host.querySelector(".linb-sf.held")?.textContent).toBe("S");
  expect(host.querySelector(".linb-node.dimmed")).not.toBeNull();
});

it("bulk review rechecks eligible targets and reports partial failure without touching denied/final rows", async () => {
  let actions!: ReturnType<typeof useGenerationCardActions>;
  const flash = vi.fn(), reload = vi.fn().mockResolvedValue(undefined), bumpBoard = vi.fn();
  function Harness() { actions = useGenerationCardActions({ armedAutoTags: new Set(),
    bumpBoard, canFinalize: () => true, flash, navTab: noop, reload, workspace: { scope: "personal", id: null, name: null } }); return null; }
  act(() => root.render(<Harness />));
  vi.mocked(api.setReviewState).mockResolvedValueOnce(gen({ is_held: true, mirror_pending: true })).mockRejectedValueOnce(new Error("denied"));
  await act(async () => actions.onReviewSelection([
    gen({ id: "ok" }), gen({ id: "failed" }), gen({ id: "denied" }), gen({ id: "held", is_held: true }), gen({ id: "gold", is_final: true }),
  ], "held", (g) => !["denied", "gold"].includes(g.id)));
  expect(vi.mocked(api.setReviewState).mock.calls.map(([g, state]) => [g.id, state])).toEqual([["ok", "held"], ["failed", "held"]]);
  expect(flash).toHaveBeenCalledWith(expect.stringContaining("1개 적용 · 1개 실패 · 3개 유지"));
  expect(flash).toHaveBeenCalledWith(expect.stringContaining("자동 동기화"));
  expect(reload).toHaveBeenCalledTimes(1); expect(bumpBoard).toHaveBeenCalledTimes(1);
});

it("reopening a pending result cannot submit it twice", async () => {
  let actions!: ReturnType<typeof useGenerationCardActions>;
  const flash = vi.fn(), reload = vi.fn().mockResolvedValue(undefined);
  function Harness() { actions = useGenerationCardActions({ armedAutoTags: new Set(),
    bumpBoard: noop, canFinalize: () => true, flash, navTab: noop, reload, workspace: { scope: "personal", id: null, name: null } }); return null; }
  act(() => root.render(<Harness />));
  let finish!: (g: Generation) => void;
  vi.mocked(api.setReviewState).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  let pending!: Promise<void>;
  act(() => { pending = actions.onReview(gen(), "held"); });
  await act(async () => { await actions.onReview(gen(), "final"); });
  expect(api.setReviewState).toHaveBeenCalledTimes(1);
  await act(async () => { finish(gen({ is_held: true })); await pending; });
  expect(reload).toHaveBeenCalledTimes(1);
});

it("single-card review rechecks actual permission before making a request", async () => {
  let actions!: ReturnType<typeof useGenerationCardActions>;
  const flash = vi.fn(), reload = vi.fn().mockResolvedValue(undefined);
  function Harness() { actions = useGenerationCardActions({ armedAutoTags: new Set(),
    bumpBoard: noop, canFinalize: () => false, flash, navTab: noop, reload,
    workspace: { scope: "personal", id: null, name: null } }); return null; }
  act(() => root.render(<Harness />));
  await act(async () => {
    await actions.onReview(gen(), "held");
    await actions.onReview(gen(), "final");
    await actions.onReview(gen({ is_held: true }), "shared");
    await actions.onReview(gen({ is_final: true }), "unshared");
  });
  expect(api.setReviewState).not.toHaveBeenCalled(); expect(reload).not.toHaveBeenCalled();
  expect(flash).toHaveBeenCalledTimes(4);
});

it("selection arrow tooltips use short titles and include held transitions", () => {
  const onGradeStep = vi.fn();
  act(() => root.render(<LibrarySelectionActionBar selectedCount={1} selectedGenerations={[gen()]} projects={[]}
    onShare={noop} onGradeStep={onGradeStep} onDownload={noop} onResolveTransfer={noop} onResolveRetry={null}
    resolveRetryProjectName="" resolveTransferBusy={false} resolveTransferPendingCount={0}
    onCompare={noop} onAssign={noop} onDelete={noop} onRestore={noop} onPurge={noop} />));
  const buttons = host.querySelectorAll<HTMLButtonElement>(".sb-grade button");
  expect([...buttons].map((button) => button.title)).toEqual([
    "단계 내리기 (최종→공유, 공유·보류→일반)",
    "단계 올리기 (일반·보류→공유, 공유→최종)",
  ]);
  act(() => { buttons[0].click(); buttons[1].click(); });
  expect(onGradeStep.mock.calls).toEqual([["down"], ["up"]]);
});
