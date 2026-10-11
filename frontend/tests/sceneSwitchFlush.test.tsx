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

// 2026-10-11 격리 실측(dist_b46 — 8번 실행 중 4번, 부하가 걸렸을 때): 씬 탭을 X → Y → X 로 연달아 누르면 Y 가 X 의 카드로 덮였다.
//  X 로 간 동기화 effect 가 넣은 'X 의 카드로 바꾸기'는 낮은 우선순위로 밀려 있는데, 그것이 그려지기 전에 Y 로 돌아오면 Y 의 동기화
//  effect 는 "받은 카드가 이미 손에 든 그 객체"(아직 Y 의 것)라 아무것도 넣지 않았다 → 밀려 있던 X 의 카드가 뒤늦게 Y 화면에 그려지고,
//  기준(지금 씬·마지막 저장)은 Y 라 다음 탭 누름의 저장 확정이 그것을 '미저장 편집'으로 보고 Y 에 썼다.
it("씬 X 로 갔다가 그 카드가 그려지기 전에 Y 로 돌아와도 늦게 오는 X 의 카드가 Y 를 덮지 않는다 — 뒤의 저장 확정도 Y 에 X 의 카드를 쓰지 않는다", async () => {
  const { SceneBoard } = await import("../src/components/scene/SceneBoard");
  const { flushSync } = await import("react-dom");
  const saved: { scene: string; cards: string[] }[] = [];
  let switchTo!: (scene: Scene) => void;
  let actions!: { current: Actions };
  function Host() {
    const [scene, setScene] = useState(sceneY);
    switchTo = setScene;
    const actionRef = useRef(null as unknown as Actions);
    actions = actionRef;
    return (
      <SceneBoard
        scene={scene}
        actionRef={actionRef as BoardProps["actionRef"]}
        onChange={(patch) => saved.push({ scene: scene.id, cards: (patch.cards ?? []).map((card) => card.id) })}
      />
    );
  }
  const shown = () => [...view.container.querySelectorAll<HTMLElement>(".scene-card")].map((card) => card.dataset.id);
  act(() => view.root.render(<Host />));
  await settle();
  expect(shown()).toEqual(["y1"]);
  saved.length = 0;

  // 탭 누름은 동기 렌더다(그 동기화 effect 까지 그 자리에서 돈다). effect 가 넣는 카드 갱신은 그 뒤의 낮은 우선순위 렌더로 밀린다.
  await act(async () => {
    flushSync(() => switchTo(sceneX));
    flushSync(() => switchTo(sceneY)); // X 의 카드가 그려지기 전에 돌아온다
  });
  await settle();
  expect(shown(), "Y 화면의 카드").toEqual(["y1"]);
  act(() => actions.current?.flushPending()); // 다음 탭 누름(selectScene)이 먼저 하는 일
  expect(saved, "Y 에 쓴 저장").toEqual([]);

  // 한 번 더 오가도 같다 — X → Y → X 로 끝나면 X 의 카드
  await act(async () => {
    flushSync(() => switchTo(sceneX));
    flushSync(() => switchTo(sceneY));
    flushSync(() => switchTo(sceneX));
  });
  await settle();
  expect(shown()).toEqual(["x1", "x2"]);
  act(() => actions.current?.flushPending());
  expect(saved).toEqual([]);
});

// Codex 코드 리뷰 P1(2026-10-11): 카드의 주인 씬을 sceneIdRef 로 읽으면, 씬을 바꾼 직후(동기화 effect 는 돌았고 카드 갱신은 밀려 있다)
//  **씬을 바꾸지 않는 다른 동기 렌더**(Ctrl+K 로 프롬프트를 숨김 등)가 낄 때 옛 씬의 카드에 새 씬의 이름이 붙는다 — 방어를 지나 저장된다.
it("씬을 바꾼 직후 다른 동기 렌더가 끼어도, 아직 그려진 옛 씬의 카드를 새 씬의 미저장 편집으로 보지 않는다", async () => {
  const { SceneBoard } = await import("../src/components/scene/SceneBoard");
  const { flushSync } = await import("react-dom");
  const saved: { scene: string; cards: string[] }[] = [];
  let switchTo!: (scene: Scene) => void;
  let rerender!: () => void;
  let actions!: { current: Actions };
  function Host() {
    const [scene, setScene] = useState(sceneY);
    const [, setTick] = useState(0);
    switchTo = setScene;
    rerender = () => setTick((n) => n + 1);
    const actionRef = useRef(null as unknown as Actions);
    actions = actionRef;
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
  saved.length = 0;

  await act(async () => {
    flushSync(() => switchTo(sceneX)); // 탭 누름 — X 의 카드 갱신은 아직 밀려 있다(화면은 Y 의 카드)
    flushSync(() => rerender()); // 씬은 그대로인 다른 동기 렌더
    expect(actions.current?.sceneId, "아직 그려진 카드의 주인").toBe(sceneY.id); // 카드는 아직 Y 의 것 — 이름도 Y 여야 한다
    actions.current?.flushPending(); // 카드 갱신 전의 저장 확정(다음 탭 누름·카메라 저장·입력 디바운스가 부른다)
  });
  expect(saved, "X 에 쓴 저장").toEqual([]);
  await settle();
  expect([...view.container.querySelectorAll<HTMLElement>(".scene-card")].map((card) => card.dataset.id)).toEqual(["x1", "x2"]);
  expect(actions.current?.sceneId, "카드가 바뀐 뒤의 주인").toBe(sceneX.id); // 카드와 같은 갱신으로 바뀐다
  act(() => actions.current?.flushPending());
  expect(saved).toEqual([]);
});

// Codex 코드 리뷰 P1(2026-10-11, 3차): 틈에 들어온 **실제 편집**은 밀려 있는 '새 씬의 카드로 바꾸기' 뒤에 줄을 서 다시 적용된다 —
//  떠난 씬의 편집본이 새 씬의 이름으로 남고, 그 자리에서 저장하는 편집(삭제·색)은 곧바로 새 씬에 쓰인다. 틈에는 편집·저장을 받지 않는다.
it("씬을 바꾸는 틈에 아직 보이는 옛 씬의 카드를 지워도(밀려 있던 키) 새 씬에 쓰이지 않고, 새 씬의 카드가 그대로 그려진다", async () => {
  const { SceneBoard } = await import("../src/components/scene/SceneBoard");
  const { flushSync } = await import("react-dom");
  const saved: { scene: string; cards: string[] }[] = [];
  let switchTo!: (scene: Scene) => void;
  let actions!: { current: Actions };
  function Host() {
    const [scene, setScene] = useState(sceneY);
    switchTo = setScene;
    const actionRef = useRef(null as unknown as Actions);
    actions = actionRef;
    return (
      <SceneBoard
        scene={scene}
        actionRef={actionRef as BoardProps["actionRef"]}
        onChange={(patch) => saved.push({ scene: scene.id, cards: (patch.cards ?? []).map((card) => card.id) })}
      />
    );
  }
  const shown = () => [...view.container.querySelectorAll<HTMLElement>(".scene-card")].map((card) => card.dataset.id);
  const press = (target: EventTarget, type: string, init: object = {}) =>
    target.dispatchEvent(type.startsWith("key")
      ? new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init })
      : new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init }));
  act(() => view.root.render(<Host />));
  await settle();
  // Y 의 카드를 고른다(보드에 초점)
  act(() => { press(view.container.querySelector('.scene-card[data-id="y1"]')!, "mousedown"); });
  act(() => { press(window, "mouseup"); });
  expect(view.container.querySelectorAll(".scene-card.sel, .scene-card.selected").length).toBe(1);
  saved.length = 0;

  await act(async () => {
    flushSync(() => switchTo(sceneX)); // 탭 누름 — 화면은 아직 Y 의 카드
    expect(shown()).toEqual(["y1"]);
    // 틈의 보드는 누를 수 없다(inert) — 브라우저는 그 안의 요소에 누름을 보내지 않는다(jsdom 은 보낸다 — 아래 누름은 그 뒤의 방어를 본다)
    expect(view.container.querySelector(".scene-board")!.hasAttribute("inert")).toBe(true);
    // 밀려 있던 키가 틈에 들어온다 — 아직 보이는 Y 의 카드를 다시 고르고 지운다(Delete 는 그 자리에서 저장하는 편집이다)
    flushSync(() => { press(view.container.querySelector('.scene-card[data-id="y1"]')!, "mousedown"); });
    flushSync(() => { press(window, "mouseup"); });
    flushSync(() => { press(document.body, "keydown", { key: "Delete", code: "Delete" }); });
  });
  await settle();
  expect(saved, "X 에 쓴 저장").toEqual([]); // 틈의 삭제가 X 에 'Y 의 남은 카드'(빈 목록)를 쓰지 않는다
  expect(shown()).toEqual(["x1", "x2"]); // 틈의 편집본이 X 의 카드를 덮지 않는다
  expect(view.container.querySelector(".scene-board")!.hasAttribute("inert")).toBe(false); // 틈이 끝나면 보드를 다시 누를 수 있다
  expect(actions.current?.sceneId).toBe(sceneX.id);
  act(() => actions.current?.flushPending());
  expect(saved).toEqual([]);

  // 틈이 끝난 뒤의 편집은 평소대로 X 에 저장된다
  act(() => { press(view.container.querySelector('.scene-card[data-id="x1"]')!, "mousedown"); });
  act(() => { press(window, "mouseup"); });
  act(() => { press(document.body, "keydown", { key: "Delete", code: "Delete" }); });
  await settle();
  expect(shown()).toEqual(["x2"]);
  expect(saved.at(-1)).toEqual({ scene: sceneX.id, cards: ["x2"] });
});

// 틈의 방어는 겹겹이다(보드 inert · 키 · 편집용 설정자 · 저장 · 카메라). 입구(키·누름)를 거치지 않는 길 — App 이 actionRef 로 부르는
//  프롬프트 트레이 편집(setCardRefs) — 은 안쪽 방어(설정자·저장)만 지난다. 그 길로 안쪽 방어를 본다.
it("씬을 바꾸는 틈에 App 이 부른 카드 편집(트레이의 레퍼런스 저장)도 새 씬에 쓰이지 않는다", async () => {
  const { SceneBoard } = await import("../src/components/scene/SceneBoard");
  const { flushSync } = await import("react-dom");
  const genY: Scene = { id: "scene-gy", name: "GY", created_at: 3, edges: [], cards: [{ id: "g1", kind: "generation", x: 0, y: 0, refs: [] }] };
  const saved: { scene: string; cards: string[] }[] = [];
  let switchTo!: (scene: Scene) => void;
  let actions!: { current: Actions };
  function Host() {
    const [scene, setScene] = useState(genY);
    switchTo = setScene;
    const actionRef = useRef(null as unknown as Actions);
    actions = actionRef;
    return (
      <SceneBoard
        scene={scene}
        actionRef={actionRef as BoardProps["actionRef"]}
        onChange={(patch) => saved.push({ scene: scene.id, cards: (patch.cards ?? []).map((card) => card.id) })}
      />
    );
  }
  const shown = () => [...view.container.querySelectorAll<HTMLElement>(".scene-card")].map((card) => card.dataset.id);
  const ref = { type: "image" as const, file_path: "/fixtures/a.png", name: "A", thumb: "/fixtures/a.png" };
  act(() => view.root.render(<Host />));
  await settle();
  saved.length = 0;

  await act(async () => {
    flushSync(() => switchTo(sceneX)); // 탭 누름 — 화면·cardsRef 는 아직 GY 의 카드
    flushSync(() => { actions.current?.setCardRefs("g1", [ref]); }); // 트레이 편집이 그 틈에 도착
  });
  await settle();
  expect(saved, "X 에 쓴 저장").toEqual([]);
  expect(shown()).toEqual(["x1", "x2"]);
  act(() => actions.current?.flushPending());
  expect(saved).toEqual([]);
});

// Codex 코드 리뷰(5차): 붙여넣기는 키 훅과 다른 리스너다 — 틈에 누른 Ctrl+V 는 0.18초 뒤의 폴백을 예약하고, 그때는 틈이 끝나
//  '씬이 그대로인가' 검사를 지나 새 씬에 붙었다. 틈에는 예약을 걸지 않는다.
it("씬을 바꾸는 틈에 누른 Ctrl+V(밀려 있던 키)는 틈이 끝난 뒤에도 새 씬에 붙지 않는다 — 틈 뒤의 Ctrl+V 는 평소대로 붙는다", async () => {
  const { SceneBoard } = await import("../src/components/scene/SceneBoard");
  const { flushSync } = await import("react-dom");
  const saved: { scene: string; cards: string[] }[] = [];
  let switchTo!: (scene: Scene) => void;
  function Host() {
    const [scene, setScene] = useState(sceneY);
    switchTo = setScene;
    return <SceneBoard scene={scene} onChange={(patch) => saved.push({ scene: scene.id, cards: (patch.cards ?? []).map((card) => card.id) })} />;
  }
  const shown = () => [...view.container.querySelectorAll<HTMLElement>(".scene-card")].map((card) => card.dataset.id);
  const key = (init: KeyboardEventInit) => document.body.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  const waitFallback = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 260)); }); // 폴백은 0.18초 뒤
  act(() => view.root.render(<Host />));
  await settle();
  // Y 의 카드를 골라 복사해 둔다
  act(() => { view.container.querySelector('.scene-card[data-id="y1"]')!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 })); });
  act(() => { window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); });
  act(() => { key({ key: "c", code: "KeyC", ctrlKey: true }); });
  saved.length = 0;

  await act(async () => {
    flushSync(() => switchTo(sceneX));
    flushSync(() => { key({ key: "v", code: "KeyV", ctrlKey: true }); }); // 틈에 들어온 붙여넣기
  });
  await waitFallback();
  await settle();
  expect(shown()).toEqual(["x1", "x2"]);
  expect(saved, "틈의 붙여넣기가 X 에 쓴 저장").toEqual([]);

  act(() => { key({ key: "v", code: "KeyV", ctrlKey: true }); }); // 틈이 끝난 뒤
  await waitFallback();
  await settle();
  expect(shown()).toHaveLength(3);
  expect(saved.at(-1)?.scene).toBe(sceneX.id);
});

it("씬을 바꾸는 틈에는 화면 조작(F·툴바 맞춤·확대)과 보드 밖에서 시작하는 범위 선택도 받지 않는다 — 떠난 씬의 카드로 잰 화면이 새 씬에 남지 않는다", async () => {
  const { SceneBoard } = await import("../src/components/scene/SceneBoard");
  const { flushSync } = await import("react-dom");
  const cameras: string[] = [];
  let switchTo!: (scene: Scene) => void;
  let actions!: { current: Actions };
  function Host() {
    const [scene, setScene] = useState(sceneY);
    switchTo = setScene;
    const actionRef = useRef(null as unknown as Actions);
    actions = actionRef;
    return (
      <SceneBoard scene={scene} actionRef={actionRef as BoardProps["actionRef"]} onChange={() => {}} onCameraChange={() => cameras.push(scene.id)} />
    );
  }
  // jsdom 은 자리를 재 주지 않는다 — 보드에 크기를 준다(화면 맞춤이 계산되게)
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const board = this.classList.contains("scene-board");
    const [w, h] = board ? [1000, 800] : [0, 0];
    return { x: 0, y: 0, left: 0, top: 0, right: w, bottom: h, width: w, height: h, toJSON: () => ({}) } as DOMRect;
  });
  act(() => view.root.render(<Host />));
  await settle();
  const canvas = () => view.container.querySelector<HTMLElement>(".scene-canvas")!;
  const board = () => view.container.querySelector<HTMLElement>(".scene-board")!;
  const key = (init: KeyboardEventInit) => document.body.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  cameras.length = 0;

  await act(async () => {
    flushSync(() => switchTo(sceneX));
    expect(board().hasAttribute("inert")).toBe(true); // 틈의 보드는 누를 수 없다
    const before = canvas().style.transform;
    flushSync(() => { key({ key: "f", code: "KeyF" }); }); // 화면 맞춤
    flushSync(() => { actions.current?.zoomFit(); actions.current?.zoomStep(1); }); // 툴바
    expect(canvas().style.transform, "틈의 화면").toBe(before);
    // 틈의 보드는 inert 라 그 위의 누름이 '보드 밖 누름'으로 온다 — 범위 선택을 시작하지 않는다
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: 5, clientY: 5 });
    flushSync(() => { document.body.dispatchEvent(down); });
    expect(down.defaultPrevented, "틈의 범위 선택 시작").toBe(false); // 시작하면 글자 선택을 막느라 기본 동작을 막는다
    window.dispatchEvent(new MouseEvent("mouseup", { button: 0 }));
  });
  await settle();
  expect(cameras, "틈에 저장한 카메라").toEqual([]);
  expect(board().hasAttribute("inert")).toBe(false);
  // 틈이 끝난 뒤의 보드 밖 누름은 평소대로 범위 선택을 시작한다
  const outside = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: 5, clientY: 5 });
  act(() => { document.body.dispatchEvent(outside); });
  expect(outside.defaultPrevented).toBe(true);
  act(() => { window.dispatchEvent(new MouseEvent("mouseup", { button: 0 })); });
  window.getSelection()?.removeAllRanges(); // 보드로 옮긴 초점이 남긴 캐럿 — 다음 시험의 글자 선택을 막지 않게

  // 틈이 끝난 뒤에는 평소대로
  const before = canvas().style.transform;
  act(() => actions.current?.zoomFit());
  expect(canvas().style.transform).not.toBe(before);
  expect(cameras.at(-1)).toBe(sceneX.id);
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
