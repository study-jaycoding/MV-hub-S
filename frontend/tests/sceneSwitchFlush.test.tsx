// @vitest-environment jsdom
// 씬을 막 바꾼 틈의 flushPending — 그때 캔버스가 손에 든 카드는 **떠난 씬**의 것이다. 거기서 저장을 확정하면 방금 연 씬이
// 앞 씬의 카드로 덮인다(2026-10-10 격리 브라우저 실측: 씬 탭을 25ms 안에 연달아 누르면 9/9 재현, 새로 고침 뒤에도 남았다).
// 틈 = SceneBoard 의 씬 동기화 effect 는 돌았고(기준이 새 씬으로 바뀜) 새 카드는 아직 안 그려진 사이. 부모의 effect 가 그 자리다.
import { act, useEffect, useRef, useState, type ComponentProps } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Scene } from "../src/lib/scenes";
import { createRenderRoot, installPromptBoundaryMocks, settle } from "./seedanceRenderHarness";

type BoardProps = ComponentProps<typeof import("../src/components/scene/SceneBoard").SceneBoard>;
type Actions = NonNullable<BoardProps["actionRef"]>["current"];
const text = (id: string, x: number) => ({ id, kind: "text" as const, x, y: 0, text: id });
const sceneX: Scene = { id: "scene-x", name: "X", created_at: 1, edges: [], cards: [text("x1", 0), text("x2", 300)] };
const sceneY: Scene = { id: "scene-y", name: "Y", created_at: 2, edges: [], cards: [text("y1", 0)] };

let view: ReturnType<typeof createRenderRoot>;
let boundary: ReturnType<typeof installPromptBoundaryMocks>;

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  boundary = installPromptBoundaryMocks();
  boundary.fetch.mockImplementation((...args: unknown[]) => {
    const [url, options] = args as [string, RequestInit | undefined];
    if (url.startsWith("/api/generation-views") && !options?.method) {
      return Promise.resolve(new Response(JSON.stringify({ card: {}, last_card_id: null }))) as never;
    }
    return Promise.reject(new Error(`예상 밖 HTTP 요청: ${url}`));
  });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} unobserve() {} });
  Object.defineProperty(Element.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  view = createRenderRoot();
});
afterEach(() => {
  view?.dispose();
  vi.restoreAllMocks();
  delete (Element.prototype as { scrollTo?: unknown }).scrollTo;
  vi.unstubAllGlobals();
});

it("씬을 막 바꾼 틈에 저장을 확정해도 새 씬에 떠난 씬의 카드를 쓰지 않는다", async () => {
  const { SceneBoard } = await import("../src/components/scene/SceneBoard");
  const saved: { scene: string; cards: string[] }[] = [];
  let switchTo!: (scene: Scene) => void;
  function Host() {
    const [scene, setScene] = useState(sceneX);
    switchTo = setScene;
    const actionRef = useRef(null as unknown as Actions);
    // 부모의 effect 는 자식의 동기화 effect 뒤·다음 렌더 앞에 돈다 — 씬 탭을 연달아 눌렀을 때의 두 번째 flushPending 과 같은 자리.
    useEffect(() => {
      if (scene.id !== sceneX.id) actionRef.current?.flushPending();
    }, [scene.id]);
    return (
      <SceneBoard
        scene={scene}
        actionRef={actionRef as BoardProps["actionRef"]}
        onChange={(patch) => saved.push({ scene: scene.id, cards: (patch.cards ?? []).map((card) => card.id) })}
      />
    );
  }
  act(() => view.root.render(<Host />));
  await settle();
  expect(view.container.querySelectorAll(".scene-card").length).toBe(2);
  saved.length = 0;

  act(() => switchTo(sceneY));
  await settle();
  expect(saved, "새 씬에 쓴 저장").toEqual([]);
  expect(view.container.querySelectorAll(".scene-card").length).toBe(1);
});

it("보드를 누르면 화면에 남은 글자 선택을 걷고, 보드 안에서 시작한 브라우저의 끌기(선택한 글자)는 받지 않는다 — 카드 끌기가 갇히지 않게", async () => {
  // 2026-10-10 실측: 씬 탭 줄에서 끌기 시작하거나 창 위에서 Ctrl+A 를 눌러 글자가 선택된 뒤 카드를 끌면, 브라우저가 '선택한 글자 끌기'로
  //  가로채(dragstart) mousemove·mouseup 이 끊기고 보드가 끌기 상태에 갇혔다.
  const { SceneBoard } = await import("../src/components/scene/SceneBoard");
  act(() => view.root.render(<SceneBoard scene={sceneX} onChange={() => {}} />));
  await settle();
  const board = view.container.querySelector<HTMLElement>(".scene-board")!;
  const card = view.container.querySelector<HTMLElement>(".scene-card")!;
  const label = document.createElement("span");
  label.textContent = "씬 탭 이름";
  document.body.appendChild(label);
  try {
    const range = document.createRange();
    range.selectNodeContents(label);
    window.getSelection()!.addRange(range);
    expect(String(window.getSelection())).toBe("씬 탭 이름");
    // jsdom 은 초점을 옮기기만 해도 선택을 빈 캐럿으로 바꾼다 — 결과(남은 글자)만으로는 보드가 걷었는지 알 수 없어, 걷는 호출을 본다.
    const cleared = vi.spyOn(window.getSelection()!, "removeAllRanges");
    act(() => { card.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 })); });
    act(() => { window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); });
    expect(cleared).toHaveBeenCalled();
    expect(String(window.getSelection())).toBe("");

    const plain = new Event("dragstart", { bubbles: true, cancelable: true });
    act(() => { card.dispatchEvent(plain); });
    expect(plain.defaultPrevented).toBe(true);
    const draggable = document.createElement("div");
    draggable.setAttribute("draggable", "true");
    board.appendChild(draggable); // 끌 수 있게 만든 것(결과 창의 카드)은 그대로
    const wanted = new Event("dragstart", { bubbles: true, cancelable: true });
    act(() => { draggable.dispatchEvent(wanted); });
    expect(wanted.defaultPrevented).toBe(false);
    draggable.remove();
  } finally {
    label.remove();
  }
});

it("위에 창이 떠 있을 때 보드의 빈 곳을 누르면(바깥을 눌러 닫는 클릭) 뒤의 선택이 풀리지 않는다", async () => {
  const { SceneBoard } = await import("../src/components/scene/SceneBoard");
  const { useEscapeClose } = await import("../src/lib/useEscapeClose");
  function Overlay() { useEscapeClose(() => {}); return null; }
  const draw = (overlay: boolean) => act(() => view.root.render(<>{overlay ? <Overlay /> : null}<SceneBoard scene={sceneX} onChange={() => {}} /></>));
  draw(false);
  await settle();
  const board = view.container.querySelector<HTMLElement>(".scene-board")!;
  const card = view.container.querySelector<HTMLElement>(".scene-card")!;
  const press = (target: EventTarget) => {
    act(() => { target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX: 5, clientY: 5 })); });
    act(() => { window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 5, clientY: 5 })); });
  };
  const chosen = () => view.container.querySelectorAll(".scene-card.sel, .scene-card.selected").length;
  press(card);
  expect(chosen()).toBe(1);
  draw(true);
  press(board);
  expect(chosen()).toBe(1);
  draw(false);
  press(board); // 창이 없으면 빈 곳 클릭 = 선택 해제
  expect(chosen()).toBe(0);
});
