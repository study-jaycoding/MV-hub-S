// @vitest-environment jsdom
// 캔버스 '생성 결과' 창의 끌기 — 창은 라이브러리 카드를 쓰는데, 카드는 자기 id 하나만 싣는다. 사이드바 폴더에 '고른 묶음'을
// 한 번에 담으려면 창이 묶음 전체(generationList)를 실어야 한다. 카드의 그립은 dragstart 전파를 멈추므로 캡처 단계에서 싣는다.
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SceneVariantPopup } from "../src/components/scene/SceneVariantPopup";
import { DRAG_TYPES } from "../src/lib/dragTypes";
import type { Generation } from "../src/types";

vi.mock("virtua", async () => {
  const { forwardRef } = await import("react");
  return { Virtualizer: forwardRef((props: { data: unknown[]; children: (row: unknown) => React.ReactNode }, _ref) => <>{props.data.map(props.children)}</>) };
});
vi.mock("../src/api", () => ({ api: { thumbOrRaw: (path: string) => path, mediaUrl: (path: string) => path, prefetchGenComments: () => {} } }));
vi.mock("../src/lib/useGenerationViewsSynced", () => ({ useGenerationViewsSynced: () => ({ card: {}, asset: {} }) }));
vi.mock("../src/lib/useOutsideDragSelect", () => ({ useOutsideDragSelect: () => {} }));
vi.mock("../src/lib/modelCatalog", () => ({ useModelDisplayName: () => (name: string) => name }));

const noop = () => {};
const generation = (id: string): Generation => ({
  id, worker_id: "worker", worker_name: null, prompt: id, display_prompt: null, model: null, params: {}, color: null,
  status: "done", error: null, created_at: "2026-10-07 00:00:00", tags: [], auto_tags: [], references: [],
  assets: [{ id: `asset-${id}`, generation_id: id, type: "image", file_path: `/${id}.png`, thumbnail_path: null, source_url: null, cached: true }],
  shared: false, parent_gen_id: null, is_source: false, source_name: null, comment: null, comment_count: 0, has_unread: false,
  local_only: false, creator_uid: null, creator_name: null, is_mine: true, workspace_scope: "personal", workspace_id: null,
  workspace_name: null, project_id: null, deleted: false,
} as Generation);
const gens = ["a", "b", "c"].map(generation);
const setGripDragging = vi.fn();
let root: Root;
let host: HTMLDivElement;

function props(selected: string[], gripDragging = false): ComponentProps<typeof SceneVariantPopup> {
  return {
    card: { id: "card", kind: "generation", genId: "a", genIds: ["a", "b", "c"], x: 0, y: 0 }, total: 3, sceneId: "scene",
    generations: gens, dimIds: new Set(), disabledIds: new Set(), projects: [], autoTagOptions: [],
    view: { scale: 1, layout: "grid", groupByDate: false, fill: true },
    ui: {
      selectedIds: new Set(selected), setSelected: noop, resolveHighlightedIds: new Set(), scrollRequest: null,
      gripDragging, setGripDragging,
    },
    gen: { onBulkTags: noop, onPublish: noop, onUnpublish: noop, onFinalize: noop, onUnfinalize: noop },
    actions: { setCardMenu: noop, setCardVariant: noop, pruneVariants: noop, latestCard: () => undefined },
  };
}
const render = (selected: string[], gripDragging = false) => act(() => root.render(<SceneVariantPopup {...props(selected, gripDragging)} />));
// jsdom 에는 DragEvent·DataTransfer 가 없다 — dragstart 에 dataTransfer 대역을 달아 보낸다(React 는 native 의 것을 그대로 읽는다).
function dragFrom(element: Element): Record<string, string> {
  const data: Record<string, string> = {};
  const event = new Event("dragstart", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { setData: (type: string, value: string) => { data[type] = value; }, effectAllowed: "" } });
  act(() => { element.dispatchEvent(event); });
  return data;
}
const card = (id: string) => host.querySelector<HTMLElement>(`.scene-varwin .gen-cell[data-id="${id}"] .card`)!;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  setGripDragging.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("고른 묶음 안의 카드를 끌면 묶음 전체를, 밖의 카드를 끌면 그 카드만 싣는다 — 그립에서 끌어도 같다", () => {
  render(["a", "c"]);
  // 묶음 안: 카드 자신(generation — 프롬프트 재사용용) + 고른 전체(generationList — 폴더 담기용, 보이는 순서)
  expect(dragFrom(card("c"))).toEqual({ [DRAG_TYPES.generation]: "c", [DRAG_TYPES.generationList]: "a,c" });
  expect(setGripDragging).toHaveBeenLastCalledWith(true); // 막을 클릭통과로 — 아래 프롬프트에 놓을 수 있다
  // 묶음 밖: 그 카드만(고른 것이 따라오지 않는다)
  expect(dragFrom(card("b"))).toEqual({ [DRAG_TYPES.generation]: "b", [DRAG_TYPES.generationList]: "b" });
  // 그립은 dragstart 전파를 멈춘다 — 그래도 묶음이 실린다(캡처 단계)
  const grip = card("a").querySelector(".card-drag-grip")!;
  expect(dragFrom(grip)).toEqual({ [DRAG_TYPES.generation]: "a", [DRAG_TYPES.generationList]: "a,c" });
});

it("끌기가 dragend 없이 끝나도 막의 클릭통과를 푼다 — 안 풀리면 창을 누를 수 없다", () => {
  render([], true);
  expect(host.querySelector(".scene-varpop-backdrop")!.classList.contains("drag-through")).toBe(true);
  act(() => { window.dispatchEvent(new MouseEvent("mouseup")); });
  expect(setGripDragging).toHaveBeenLastCalledWith(false);
  // 끄는 중이 아니면 듣지 않는다
  setGripDragging.mockClear();
  render([], false);
  act(() => { window.dispatchEvent(new MouseEvent("mouseup")); });
  expect(setGripDragging).not.toHaveBeenCalled();
});

it("'대표' 단추를 누르면 그 결과가 카드 대표가 되고, 카드 선택·끌기로 번지지 않는다", () => {
  const setCardVariant = vi.fn();
  const setSelected = vi.fn();
  const base = props([]);
  act(() => root.render(<SceneVariantPopup {...base} ui={{ ...base.ui, setSelected }} actions={{ ...base.actions, setCardVariant }} />));
  const cell = (id: string) => host.querySelector<HTMLElement>(`.scene-varwin .gen-cell[data-id="${id}"]`)!;
  expect(cell("a").querySelector(".gen-cell-head")!.textContent).toBe("★ 대표"); // 지금 대표 — 표시만
  expect(cell("a").querySelector("button.scene-varpop-rep")).toBeNull();
  const button = cell("b").querySelector<HTMLButtonElement>("button.scene-varpop-rep")!;
  act(() => {
    button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
  });
  expect(setCardVariant).toHaveBeenCalledExactlyOnceWith("card", "b");
  expect(setSelected).not.toHaveBeenCalled();
});
