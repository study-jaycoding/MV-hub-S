// @vitest-environment jsdom
// 캔버스 폴더 창에서 생성물을 끌어 씬에 놓기(Jay 10-22, Codex 설계 검토) — 보드는 생성물 끌기를 받아 그 생성물의 '생성물 카드'(결과 그대로)를
//  만든다. 붙여넣기처럼 결과를 지우지 않는다. 폴더 창 안에서 시작한 끌기만 창을 비키게 알린다.
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DRAG_TYPES } from "../src/lib/dragTypes";
import { applyCanvasEdit } from "../src/features/canvas/edits";
import { useCanvasSession } from "../src/features/canvas/api";
import { useSceneClipboardDrop } from "../src/lib/useSceneClipboardDrop";
import { notifyGenerationDragStart, onPeekGenerationDragStart } from "../src/lib/peekDragOut";
import type { SceneCard, SceneEdge } from "../src/lib/scenes";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const generationCard = (id: string, genId: string | null): SceneCard =>
  ({ id, kind: "generation", x: 0, y: 0, genId, genIds: genId ? [genId] : [], status: "done" }) as SceneCard;

it("addGenerationCards 는 결과(genId·genIds·상태)를 그대로 둔 생성물 카드를 더한다 — 같은 카드 id·결과 없는 카드는 빼고, 더할 게 없으면 바꾸지 않는다", () => {
  const existing = generationCard("c1", "g0");
  const edit = applyCanvasEdit({ cards: [existing], edges: [], groups: [] },
    { type: "addGenerationCards", cards: [generationCard("c2", "g1"), generationCard("c1", "g9"), generationCard("c3", null)] }, {});
  expect(edit?.policy).toBe("user"); // 사용자 편집 — 저장·실행 취소 경로
  const added = edit!.snapshot.cards.find((card) => card.id === "c2")!;
  expect(added).toMatchObject({ kind: "generation", genId: "g1", genIds: ["g1"], status: "done" });
  expect(edit!.snapshot.cards.map((card) => card.id)).toEqual(["c1", "c2"]);
  expect(applyCanvasEdit({ cards: [existing], edges: [], groups: [] }, { type: "addGenerationCards", cards: [generationCard("c1", "g1")] }, {})).toBeNull();
});

function mountBoardDrop(onDropGenerations?: (ids: string[], point: { x: number; y: number }) => void) {
  let handlers!: ReturnType<typeof useSceneClipboardDrop>;
  function Host() {
    const sceneIdRef = useRef("s");
    const cardsRef = useRef<SceneCard[]>([]), edgesRef = useRef<SceneEdge[]>([]), groupsRef = useRef([]);
    const document = useCanvasSession({ sceneId: "s", sceneIdRef, cardsRef, edgesRef, groupsRef,
      initialSnapshot: { cards: [], edges: [], groups: [] }, setCards: () => {}, setEdges: () => {}, setGroups: () => {},
      frozenRef: useRef(false), layerMoveRef: useRef(null), clearSelection: () => {}, onChange: () => {} });
    handlers = useSceneClipboardDrop({
      document, frozenRef: useRef(false), sceneIdRef, cardsRef, edgesRef,
      selectedRef: useRef(new Set<string>()), lastMouseRef: useRef({ x: 10, y: 10, over: true }), scrollRef: useRef<HTMLDivElement | null>(null),
      setSelected: () => {}, toCanvas: (x, y) => ({ x: x * 2, y: y * 2 }), cardWidth: 100, cardHeight: 100, onDropGenerations,
    });
    return null;
  }
  act(() => root.render(<Host />));
  return () => handlers;
}
function dragEvent(data: Record<string, string>) {
  const board = document.createElement("div");
  const target = document.createElement("div");
  board.append(target);
  const dataTransfer = { types: Object.keys(data), getData: (type: string) => data[type] ?? "", dropEffect: "none", files: [] as unknown as FileList, items: [] as unknown as DataTransferItemList };
  return { target, currentTarget: board, dataTransfer, clientX: 30, clientY: 40, shiftKey: false,
    preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as React.DragEvent;
}

it("보드에 생성물 끌기를 놓으면 놓은 자리(캔버스 좌표)와 id 를 넘긴다 — 목록이 있으면 목록(겹친 id·빈칸 정리), 끄는 동안 '복사' 표시", () => {
  const onDropGenerations = vi.fn();
  const handlers = mountBoardDrop(onDropGenerations);
  const over = dragEvent({ [DRAG_TYPES.generation]: "g1" });
  handlers().onDragOver(over);
  expect(over.dataTransfer.dropEffect).toBe("copy");
  handlers().onDrop(dragEvent({ [DRAG_TYPES.generation]: "g1" }));
  expect(onDropGenerations).toHaveBeenLastCalledWith(["g1"], { x: 60, y: 80 });
  handlers().onDrop(dragEvent({ [DRAG_TYPES.generationList]: "a, b,a,,", [DRAG_TYPES.generation]: "z" }));
  expect(onDropGenerations).toHaveBeenLastCalledWith(["a", "b"], { x: 60, y: 80 });
});

it("받는 쪽이 없으면(다른 보드) 생성물 끌기에 '복사' 표시를 하지 않는다", () => {
  const handlers = mountBoardDrop(undefined);
  const over = dragEvent({ [DRAG_TYPES.generation]: "g1" });
  handlers().onDragOver(over);
  expect(over.dataTransfer.dropEffect).toBe("none");
});

it("폴더 창 안에서 시작한 생성물 끌기만 창을 비키게 알린다", () => {
  const heard = vi.fn();
  const off = onPeekGenerationDragStart(heard);
  const peek = document.createElement("section"); peek.className = "folder-peek";
  const inside = document.createElement("div"); peek.append(inside);
  const outside = document.createElement("div");
  document.body.append(peek, outside);
  notifyGenerationDragStart(outside);
  expect(heard).not.toHaveBeenCalled();
  notifyGenerationDragStart(inside);
  expect(heard).toHaveBeenCalledTimes(1);
  off(); peek.remove(); outside.remove();
});
