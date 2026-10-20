// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SceneBoard } from "../src/components/scene/SceneBoard";
import type { Scene, SceneCard } from "../src/lib/scenes";
import type { SceneGenDataApi } from "../src/lib/useSceneGenData";

type HeadProps = React.ComponentProps<typeof import("../src/components/scene/cards/HeadCard").HeadCard>;
const fixture = vi.hoisted(() => ({ data: null as unknown as SceneGenDataApi, head: null as unknown as HeadProps }));
vi.mock("../src/lib/useSceneGenData", () => ({ useSceneGenData: () => fixture.data }));
// 카드의 공개 setter만 호출한다. Board·cardsRef·입력 예약·Undo는 실제 코드를 사용한다.
vi.mock("../src/components/scene/cards/HeadCard", () => ({ HeadCard: (props: HeadProps) => { fixture.head = props; return null; } }));
let host: HTMLDivElement;
let root: Root;
let saved: SceneCard[];
const noop = () => {};
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("BroadcastChannel", undefined);
  vi.stubGlobal("requestAnimationFrame", () => 0); vi.stubGlobal("cancelAnimationFrame", noop);
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("Unexpected network"))));
  localStorage.clear(); sessionStorage.clear();
  fixture.data = { genData: {}, genDataRef: { current: {} }, setGenData: noop, missingIds: new Set(), disabledIds: new Set(), refParents: {},
    colors: { begin: () => null, end: noop, isLive: () => false, currentIds: () => [], applyRecovered: () => [] } } as unknown as SceneGenDataApi;
  saved = [];
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  const scene = { id: "same-tick-setters", name: "S", created_at: 0, edges: [], cards: [{ id: "h", kind: "head", x: 0, y: 0, text: "old", color: "#e8c341", fontSize: 32 }] } as Scene;
  await act(async () => { root.render(<SceneBoard scene={scene} onChange={(patch) => { if (patch.cards) saved = patch.cards; }} />); });
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const undo = () => act(async () => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "z", code: "KeyZ", ctrlKey: true, bubbles: true, cancelable: true })); });

it("같은 틱에 text→color→font setter를 호출해도 앞 입력을 보존하고 순서대로 Undo한다", async () => {
  const setters = fixture.head;
  act(() => { setters.setNodeText("h", "new"); setters.setNodeColor("h", "#ff0000"); setters.setNodeFontSize("h", 48); });
  expect(saved[0]).toMatchObject({ text: "new", color: "#ff0000", fontSize: 48 });
  await undo(); expect(saved[0]).toMatchObject({ text: "new", color: "#ff0000", fontSize: 32 });
  await undo(); expect(saved[0]).toMatchObject({ text: "old", color: "#e8c341", fontSize: 32 });
});
it("입력 대기 중 color 저장은 최신 text를 포함하며 한 번의 Undo로 함께 되돌린다", async () => {
  act(() => fixture.head.setNodeText("h", "pending input"));
  expect(saved).toEqual([]);
  act(() => fixture.head.setNodeColor("h", "#00ff00"));
  expect(saved[0]).toMatchObject({ text: "pending input", color: "#00ff00" });
  await undo(); expect(saved[0]).toMatchObject({ text: "old", color: "#e8c341" });
});
