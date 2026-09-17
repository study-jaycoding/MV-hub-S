// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SceneBoard } from "../src/components/scene/SceneBoard";
import { GenerationCard as CanvasGenerationCard, type HistPass } from "../src/components/scene/cards/GenerationCard";
import { ComfyCard } from "../src/components/scene/cards/ComfyCard";
import type { Scene, SceneCard } from "../src/lib/scenes";
import type { SceneGenDataApi } from "../src/lib/useSceneGenData";
import type { Generation } from "../src/types";

// Only data loading is replaced: SceneBoard, both wrappers and HistoryBoardNode stay real.
const fixture = vi.hoisted(() => ({ data: null as unknown as SceneGenDataApi }));
vi.mock("../src/lib/useSceneGenData", () => ({ useSceneGenData: () => fixture.data }));

const noop = () => {};
let host: HTMLDivElement;
let root: Root;
function gen(patch: Partial<Generation> = {}): Generation {
  return {
    id: "canvas-share-gen", worker_id: "test-worker", worker_name: null, prompt: "Synthetic card",
    display_prompt: null, model: null, params: {}, color: null, status: "done", error: null,
    created_at: "2026-09-17 00:00:00", assets: [], references: [], tags: [], auto_tags: [],
    shared: false, is_held: false, is_final: false, parent_gen_id: null, is_source: false,
    source_name: null, comment: null, comment_count: 0, has_unread: false, local_only: false,
    creator_uid: null, creator_name: null, is_mine: false, workspace_scope: "personal",
    workspace_id: null, workspace_name: null, project_id: null, deleted: false, ...patch,
  };
}
function card(kind: "generation" | "comfy", generation: Generation): SceneCard {
  return { id: `card-${kind}`, kind, genId: generation.id, x: 0, y: 0,
    ...(kind === "comfy" ? { comfyCfg: { name: "Synthetic workflow", content: "{}", status: "done" as const } } : {}),
  };
}
function hist(canFinalize?: HistPass["canFinalize"]): HistPass {
  return { disabledIds: new Set(), typeFilter: "all", colorFilter: new Set(), tagFilter: new Set(),
    sharedOnly: false, commentOnly: false, finalOnly: false, folderSel: null, sConfirm: null,
    onSClick: vi.fn(), onSDouble: vi.fn(), onSConfirmYes: noop, onSConfirmNo: noop,
    ...(canFinalize ? { canFinalize } : {}),
  };
}
function generationProps(g: Generation, h: HistPass): ComponentProps<typeof CanvasGenerationCard> {
  return { card: card("generation", g), sel: false, g, showNode: true, waiting: false, genMissing: false,
    width: 180, height: 180, fill: true, selectedOnly: false, laneDelta: () => 0,
    getNodePreview: () => noop, hist: h,
    actions: { setCardMenu: noop, setCardBatch: noop, orchestrateGenerate: async () => {},
      showGenerateBar: false, onOutPortDown: noop, onResizeDown: noop },
    tagEdit: { active: false, hasAutoTags: false, autoTagOptions: [], applyCardTags: noop,
      applyCardAutoTags: noop, close: noop },
  };
}
function comfyProps(g: Generation, h: HistPass): ComponentProps<typeof ComfyCard> {
  const c = card("comfy", g);
  return { card: c, sel: false, fill: true, width: 180, runningLocal: false,
    laneDelta: () => 0, getNodePreview: () => noop, hist: h,
    graph: { cards: [c], cardsById: new Map([[c.id, c]]), edges: [], refParents: {}, genData: { [g.id]: g } },
    tagEdit: { cardId: null, nodeGenId: null, enabled: false, hasAutoTags: false,
      autoTagOptions: [], applyCardTags: noop, applyCardAutoTags: noop, close: noop },
    actions: { applyComfyApi: async () => false, pickComfyFile: noop, setComfyModalId: noop,
      refreshComfy: async () => {}, setComfyParam: noop, flushPending: noop, runComfy: async () => false,
      setCardMenu: noop, setCardBatch: noop, onOutPortDown: noop, onResizeDown: noop },
  };
}
function wrapper(kind: "generation" | "comfy", g: Generation, h: HistPass) {
  return kind === "generation" ? <CanvasGenerationCard {...generationProps(g, h)} /> : <ComfyCard {...comfyProps(g, h)} />;
}
function shareActions() {
  return [...host.querySelectorAll<HTMLButtonElement>(".linb-ov-top button")]
    .filter(el => el.textContent === "S" || el.textContent === "★");
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("BroadcastChannel", undefined);
  vi.stubGlobal("WebSocket", class { constructor() { throw new Error("Unexpected socket in isolated UI test"); } });
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("Unexpected network in isolated UI test"))));
  localStorage.clear(); sessionStorage.clear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const cases = ["unshared", "shared", "held", "final"].flatMap(state => [false, true].flatMap(mine =>
  [false, true].map(may => ({ state, mine, may }))));
describe.each(["generation", "comfy"] as const)("real %s wrapper", kind => {
  it.each(cases)("$state mine=$mine may=$may keeps action eligibility separate from its status badge", ({ state, mine, may }) => {
    const g = gen({ is_mine: mine, shared: state !== "unshared", is_held: state === "held", is_final: state === "final" });
    const permission = vi.fn((candidate: Generation) => { expect(candidate).toBe(g); return may; });
    const h = hist(permission);
    act(() => root.render(wrapper(kind, g, h)));
    const expected = mine || state === "held" || state === "final" || (state === "shared" && may);
    expect(shareActions()).toHaveLength(expected ? 1 : 0);
    expect(!!host.querySelector(".linb-sf")).toBe(state !== "unshared");
    if (expected) { act(() => shareActions()[0].click()); expect(h.onSClick).toHaveBeenCalledExactlyOnceWith(g); }
    else expect(h.onSClick).not.toHaveBeenCalled();
  });
  it("omitted canFinalize retains the existing true default", () => {
    act(() => root.render(wrapper(kind, gen({ shared: true }), hist())));
    expect(shareActions()).toHaveLength(1);
    expect(host.querySelector(".linb-sf")?.textContent).toBe("S");
  });
  it("real SceneBoard forwards false → true permission for this wrapper", async () => {
    const g = gen({ shared: true });
    const data = { [g.id]: g };
    fixture.data = { genData: data, genDataRef: { current: data }, setGenData: noop,
      missingIds: new Set(), disabledIds: new Set(), refParents: {} };
    const scene: Scene = { id: `permission-${kind}`, name: "Synthetic scene", cards: [card(kind, g)], edges: [], created_at: 0 };
    const permission = vi.fn(() => false);
    await act(async () => { root.render(<SceneBoard scene={scene} onChange={noop} canFinalize={permission} />); });
    expect(host.querySelector(".linb-node")).not.toBeNull();
    expect(shareActions()).toHaveLength(0);
    expect(host.querySelector(".linb-sf")?.textContent).toBe("S");
    expect(permission).toHaveBeenCalledWith(g);
    const nextPermission = vi.fn(() => true);
    await act(async () => { root.render(<SceneBoard scene={scene} onChange={noop} canFinalize={nextPermission} />); });
    expect(shareActions()).toHaveLength(1);
    expect(host.querySelector(".linb-sf")?.textContent).toBe("S");
    expect(nextPermission).toHaveBeenCalledWith(g);
  });
});
