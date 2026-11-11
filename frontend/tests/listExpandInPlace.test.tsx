// @vitest-environment jsdom
// 캔버스 리스트 — 두 번 눌러 펼치면 텍스트 노드의 큰 편집 창처럼 카드 안에서 키워(노드 폭 1.6배) 순서를 바꾼다(Jay 2026-11-11).
//  · 접힌 노드: 끌기 손잡이 없음(썸네일을 눌러도 노드를 끈다) · 항목은 카드 칸에.
//  · 펼침: 떠 있는 칸(.scene-listfloat)에 모든 항목·끌기(startReorder) · 썸네일 1.6배 · 카드에 펼침 표식(테두리 숨김·다른 카드 위로).
//  · 접기: 바깥 누름·Esc(같은 Esc 는 '처리됨' — 보드가 선택까지 풀지 않게) · 안쪽 누름·'생성 결과' 창 누름은 그대로 · 위에 창이 떠 있으면 안 가져감.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ListCard } from "../src/components/scene/cards/ListCard";
import { CARD_W } from "../src/components/scene/sceneColors";
import { closeLayer, nextLayerSeq, openLayer } from "../src/lib/keyGate";
import { isKeyHandled } from "../src/lib/keyHandled";
import type { SceneCard, SceneEdge, SceneRef } from "../src/lib/scenes";
import type { Generation } from "../src/types";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const noop = () => {};
const ref = (name: string): SceneRef => ({ type: "image", name, file_path: `/fixtures/${name}`, thumb: `/fixtures/${name}` });
const refCards: SceneCard[] = [
  { id: "list", kind: "list", x: 0, y: 0 },
  ...["r1", "r2", "r3", "r4"].map((id, i) => ({ id, kind: "reference" as const, x: 0, y: i * 10, refs: [ref(`${id}.png`)] })),
];
const genCards: SceneCard[] = [
  { id: "list", kind: "list", x: 0, y: 0 },
  { id: "g1", kind: "generation", x: 0, y: 0, genId: "gen1" },
  { id: "g2", kind: "generation", x: 0, y: 10, genId: "gen2" },
];
const edgesTo = (ids: string[]): SceneEdge[] => ids.map((from) => ({ id: `e-${from}`, from, to: "list" }));
const genData = {
  gen1: { id: "gen1", assets: [{ type: "image", file_path: "/media/1.png" }] },
  gen2: { id: "gen2", assets: [{ type: "image", file_path: "/media/2.png" }] },
} as unknown as Record<string, Generation>;

function draw(cards: SceneCard[], edges: SceneEdge[], o: { expanded: boolean; startReorder?: () => void; onCollapse?: () => void }) {
  act(() => root.render(
    <div className="scene-card scene-card-list">
      <ListCard card={cards[0]} cardsById={new Map(cards.map((c) => [c.id, c]))} resolvedEdges={edges} genData={genData}
        disabledIds={new Set()} rowSel={{ listId: "", cids: new Set() }} reorderFrom={null} cardWidth={240} workspaceId="personal"
        toggleRowSel={noop} startReorder={o.startReorder ?? noop} getNodePreview={() => noop} setCardMenu={noop} addListAsReference={noop}
        onOutPortDown={noop} onResizeDown={noop} expanded={o.expanded} onCollapse={o.onCollapse} />
    </div>,
  ));
}
const card = () => host.querySelector<HTMLElement>(".scene-card")!;
const float = () => host.querySelector<HTMLElement>(".scene-listfloat");
const press = (el: EventTarget) => act(() => { el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 })); });
const esc = () => {
  const ev = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  act(() => { window.dispatchEvent(ev); });
  return ev;
};

it("접힌 노드 — 항목은 카드 칸에, 끌기 손잡이·썸네일 끌기 없음", () => {
  const startReorder = vi.fn();
  draw(refCards, edgesTo(["r1", "r2", "r3", "r4"]), { expanded: false, startReorder });
  expect(float()).toBeNull();
  expect(card().querySelectorAll(":scope > .scene-card-inner .scene-listthumb")).toHaveLength(4);
  press(card().querySelector(".scene-listthumb")!);
  expect(startReorder).not.toHaveBeenCalled();
  expect(card().hasAttribute("data-list-expanded")).toBe(false);
  draw(genCards, edgesTo(["g1", "g2"]), { expanded: false });
  expect(card().querySelector(".scene-listrow-grip")).toBeNull();
});

it("펼침 — 떠 있는 칸에 모든 항목·끌기, 썸네일 1.6배, 카드에 펼침 표식 · 접으면 원래대로", () => {
  const startReorder = vi.fn();
  draw(refCards, edgesTo(["r1", "r2", "r3", "r4"]), { expanded: true, startReorder });
  expect(float()).not.toBeNull();
  expect(float()!.querySelectorAll("[data-reid]")).toHaveLength(4);
  expect(card().querySelectorAll(":scope > .scene-card-inner [data-reid]")).toHaveLength(0); // 항목 칸은 한 곳에만(끌기가 칸 자리를 잰다)
  expect(card().hasAttribute("data-list-expanded")).toBe(true);
  expect(card().hasAttribute("data-pop-open")).toBe(true);
  const px = Math.max(42, Math.min(Math.round(((CARD_W * 2) / 3) * 1.5), Math.round(((240 * 1.6) / CARD_W) * 42)));
  expect(float()!.querySelector<HTMLElement>(".scene-listthumbs")!.style.gridTemplateColumns).toBe(`repeat(auto-fill, ${px}px)`);
  press(float()!.querySelectorAll(".scene-listthumb")[2]);
  expect(startReorder).toHaveBeenCalledTimes(1);
  expect(startReorder.mock.calls[0].slice(1)).toEqual(["list", "r3", "h"]);
  draw(refCards, edgesTo(["r1", "r2", "r3", "r4"]), { expanded: false });
  expect(float()).toBeNull();
  expect(card().hasAttribute("data-list-expanded")).toBe(false);
  expect(card().hasAttribute("data-pop-open")).toBe(false);
  // 생성물 리스트 — 펼치면 행마다 끌기 손잡이
  draw(genCards, edgesTo(["g1", "g2"]), { expanded: true, startReorder });
  expect(float()!.querySelectorAll(".scene-listrow-grip")).toHaveLength(2);
});

it("접기 — 바깥 누름·Esc 로 접히고(Esc 는 처리됨 표시), 안쪽·'생성 결과' 창 누름은 그대로", () => {
  const onCollapse = vi.fn();
  draw(refCards, edgesTo(["r1", "r2", "r3", "r4"]), { expanded: true, onCollapse });
  press(float()!.querySelector(".scene-listthumb")!);
  const varpop = document.createElement("div");
  varpop.className = "scene-varpop-backdrop";
  document.body.append(varpop);
  press(varpop);
  varpop.remove();
  expect(onCollapse).not.toHaveBeenCalled();
  press(document.body);
  expect(onCollapse).toHaveBeenCalledTimes(1);
  const ev = esc();
  expect(onCollapse).toHaveBeenCalledTimes(2);
  expect(isKeyHandled(ev)).toBe(true);
  // 접힌 뒤에는 듣지 않는다
  draw(refCards, edgesTo(["r1", "r2", "r3", "r4"]), { expanded: false, onCollapse });
  press(document.body);
  esc();
  expect(onCollapse).toHaveBeenCalledTimes(2);
});

it("위에 창이 떠 있으면(크게 보기 등 Esc 겹) 바깥 누름·Esc 를 가져가지 않는다", () => {
  const onCollapse = vi.fn();
  draw(refCards, edgesTo(["r1", "r2", "r3", "r4"]), { expanded: true, onCollapse });
  const token = {};
  openLayer(token, nextLayerSeq());
  try {
    press(document.body);
    const ev = esc();
    expect(onCollapse).not.toHaveBeenCalled();
    expect(isKeyHandled(ev)).toBe(false);
  } finally {
    closeLayer(token);
  }
  press(document.body);
  expect(onCollapse).toHaveBeenCalledTimes(1);
});
