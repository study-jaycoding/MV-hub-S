// @vitest-environment jsdom
// 캔버스 '생성 결과' 창의 끌기 — 창은 라이브러리 카드를 쓰는데, 카드는 자기 id 하나만 싣는다. 사이드바 폴더에 '고른 묶음'을
// 한 번에 담으려면 창이 묶음 전체(generationList)를 실어야 한다. 카드의 그립은 dragstart 전파를 멈추므로 캡처 단계에서 싣는다.
import { act, type ComponentProps, type SetStateAction } from "react";
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
  vi.useFakeTimers();
  expect(dragFrom(card("c"))).toEqual({ [DRAG_TYPES.generation]: "c", [DRAG_TYPES.generationList]: "a,c" });
  // 막의 클릭통과는 dragstart 가 끝난 뒤에 건다 — 그 안에서 걸면 브라우저가 끌기를 곧바로 취소한다(카드의 그림으로는 끌 수 없었다)
  expect(setGripDragging).not.toHaveBeenCalled();
  act(() => { vi.runAllTimers(); });
  expect(setGripDragging).toHaveBeenLastCalledWith(true); // 막을 클릭통과로 — 아래 프롬프트에 놓을 수 있다
  // 한 박자가 오기 전에 끝난 끌기에는 걸지 않는다(걸리면 창이 클릭통과로 남는다)
  setGripDragging.mockClear();
  dragFrom(card("c"));
  act(() => { card("c").dispatchEvent(new Event("dragend", { bubbles: true })); });
  act(() => { vi.runAllTimers(); });
  expect(setGripDragging).toHaveBeenCalledTimes(1);
  expect(setGripDragging).toHaveBeenLastCalledWith(false);
  vi.useRealTimers();
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
  expect(cell("a").querySelector(".gen-cell-head")!.textContent).toBe("썸네일"); // 지금 썸네일 — 표시만
  expect(cell("a").querySelector("button.scene-varpop-rep")).toBeNull();
  const button = cell("b").querySelector<HTMLButtonElement>("button.scene-varpop-rep")!;
  act(() => {
    button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
  });
  expect(setCardVariant).toHaveBeenCalledExactlyOnceWith("card", "b");
  expect(setSelected).not.toHaveBeenCalled();
  // 키보드로도 정한다(Tab 으로 와서 Enter·Space — 키보드가 만든 click 은 detail 0). 마우스가 만든 click(detail 1)은 mousedown 에서 이미 했다
  //  (조작 규칙 51 — mousedown 에만 건 실행은 키보드에 없다)
  setCardVariant.mockClear();
  act(() => { button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 })); });
  expect(setCardVariant).not.toHaveBeenCalled();
  act(() => { button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 0 })); });
  expect(setCardVariant).toHaveBeenCalledExactlyOnceWith("card", "b");
});

it("끄는 중에 창이 닫히면 기다리던 한 박자를 버린다 — 닫힌 뒤에 막의 클릭통과를 걸지 않는다", () => {
  // 실제 브라우저에서는 끄는 동안 키가 페이지로 오지 않아(Esc 는 끌기를 취소한다) 이 길을 손으로 만들기 어렵다 — 격리 실측에서도
  // 못 만들었다. 그래도 창은 다른 까닭(씬 전환·카드 삭제)으로 닫힐 수 있으니 시험으로 덮는다.
  render([]);
  vi.useFakeTimers();
  try {
    dragFrom(card("a"));
    act(() => root.render(<></>)); // 창이 닫혔다(dragend 는 오지 않았다)
    act(() => { vi.runAllTimers(); });
    expect(setGripDragging).not.toHaveBeenCalledWith(true);
  } finally {
    vi.useRealTimers();
  }
});

// 15회차(Codex 전수 검토): 전부 지우면 창을 닫는데, 닫기가 '지금 열린 창'을 닫았다 — 지우는 응답을 기다리는 사이 이 창을 닫고 다른 카드의
//  결과 창을 열었으면, 앞 창의 지우기가 끝나는 순간 새로 연 창이 닫혔다.
it("전부 지운 창은 닫힌다 — 기다리는 사이 다른 카드의 창을 열었으면 그 창은 닫지 않는다", async () => {
  let open: string | null = "card"; // SceneBoard 의 cardMenu(결과 창이 열린 카드)
  const setCardMenu = (next: SetStateAction<string | null>) => { open = typeof next === "function" ? next(open) : next; };
  let finish!: (ids: string[]) => void;
  const onVariantDelete = vi.fn(() => new Promise<string[]>((resolve) => { finish = resolve; }));
  const base = props(["a", "b", "c"]);
  act(() => root.render(<SceneVariantPopup {...base} actions={{ ...base.actions, setCardMenu, onVariantDelete }} />));
  const pressDelete = () => act(() => host.querySelector<HTMLButtonElement>(".scene-varwin .sb-del")!.click());
  pressDelete();
  expect(onVariantDelete).toHaveBeenCalledTimes(1);
  open = "other-card"; // 응답 전에 이 창을 닫고 다른 카드의 창을 열었다
  await act(async () => { finish(["a", "b", "c"]); });
  expect(open).toBe("other-card"); // 전엔 null — 새로 연 창이 닫혔다
  open = "card"; // 그대로 떠 있었으면 닫힌다
  pressDelete();
  await act(async () => { finish(["a", "b", "c"]); });
  expect(open).toBeNull();
});
