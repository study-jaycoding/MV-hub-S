// 씬을 바꾸면 옛 씬의 창·조작 상태가 남지 않는다(2026-09-29, Codex 전수 표) — 실제 SceneBoard 로 본다.
// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SceneBoard } from "../src/components/scene/SceneBoard";
import type { Scene } from "../src/lib/scenes";
import type { SceneGenDataApi } from "../src/lib/useSceneGenData";

// 바꾸는 것은 생성물 읽기뿐 — SceneBoard·단축키·끌기 세션은 실제 코드다.
const fixture = vi.hoisted(() => ({ data: null as unknown as SceneGenDataApi }));
vi.mock("../src/lib/useSceneGenData", () => ({ useSceneGenData: () => fixture.data }));

const noop = () => {};
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("BroadcastChannel", undefined);
  vi.stubGlobal("WebSocket", class { constructor() { throw new Error("Unexpected socket in isolated UI test"); } });
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("Unexpected network in isolated UI test"))));
  localStorage.clear();
  sessionStorage.clear();
  fixture.data = {
    genData: {}, genDataRef: { current: {} }, setGenData: noop,
    missingIds: new Set(), disabledIds: new Set(), refParents: {},
  } as unknown as SceneGenDataApi;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const sceneOf = (id: string, cards: object[]): Scene =>
  ({ id, name: id, created_at: 0, edges: [], cards }) as unknown as Scene;
const textCard = (id: string, x: number) => ({ id, kind: "text", x, y: 0, text: id });
const show = (scene: Scene) =>
  act(async () => {
    root.render(<SceneBoard scene={scene} onChange={noop} />);
  });
const press = (key: string, code: string, ctrlKey = false) =>
  act(async () => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key, code, ctrlKey, bubbles: true, cancelable: true }));
  });
const selectedCount = () => host.querySelectorAll(".scene-card.sel").length;

it("노드 선택기를 연 채 씬을 바꾸면 선택기가 닫히고, 새 씬에서 단축키가 먹는다(A→B→A 도)", async () => {
  const openPicker = async () => {
    const board = host.querySelector<HTMLElement>(".scene-board")!;
    await act(async () => {
      board.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 50, clientY: 50 }));
    });
    await press("Tab", "Tab");
    expect(host.querySelector(".scene-nodepick-backdrop")).not.toBeNull();
  };
  await show(sceneOf("A", [textCard("a1", 0)]));
  await openPicker();
  // 같은 씬이 다시 그려질 때(생성 완료 등으로 카드가 바뀜)는 닫지 않는다
  await show(sceneOf("A", [textCard("a1", 0), textCard("a2", 300)]));
  expect(host.querySelector(".scene-nodepick-backdrop")).not.toBeNull();

  await show(sceneOf("B", [textCard("b1", 0), textCard("b2", 300)]));
  expect(host.querySelector(".scene-nodepick-backdrop")).toBeNull(); // 옛 씬 좌표의 선택기가 남지 않는다
  await press("a", "KeyA", true);
  expect(selectedCount()).toBe(2);

  await openPicker();
  await show(sceneOf("A", [textCard("a1", 0)])); // 되돌아가도 정리한다
  expect(host.querySelector(".scene-nodepick-backdrop")).toBeNull();
});

it("결과 팝업을 연 채 씬을 바꾸면, 안 보이는 팝업이 새 씬의 단축키를 막지 않는다", async () => {
  await show(sceneOf("A", [{ id: "gen1", kind: "generation", x: 0, y: 0, genIds: ["g1", "g2"], genId: "g1" }]));
  await act(async () => {
    host.querySelector<HTMLElement>(".scene-multi-badge")!.click();
  });
  expect(host.querySelector(".scene-varpop-backdrop")).not.toBeNull();

  await show(sceneOf("B", [textCard("b1", 0), textCard("b2", 300)]));
  expect(host.querySelector(".scene-varpop-backdrop")).toBeNull();
  await press("a", "KeyA", true); // 예전에는 Esc 를 누르기 전까지 0장이었다(격리 서버 재현)
  expect(selectedCount()).toBe(2);
});

it("카드를 누른 채 씬을 바꾸면 옛 끌기는 버린다 — 놓아도 새 씬의 같은 id 카드를 고르지 않는다(Codex)", async () => {
  await show(sceneOf("A", [textCard("c1", 0)]));
  await act(async () => {
    host.querySelector<HTMLElement>('[data-id="c1"]')!.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 10, clientY: 10 }),
    );
  });

  await show(sceneOf("B", [textCard("c1", 0), textCard("c2", 300)]));
  await act(async () => {
    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
  });

  expect(selectedCount()).toBe(0);
  expect(host.querySelector(".scene-board")!.classList.contains("dragging")).toBe(false);
});
