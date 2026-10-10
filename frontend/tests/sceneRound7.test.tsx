// @vitest-environment jsdom
// 조작 점검 7회차 — 캔버스. 실제 SceneBoard(+ 실제 '생성 결과' 창·실제 프롬프트 도크)로 본다.
//  R6    f(맞춤)로 맞춘 카드가 하단 프롬프트 뒤에 놓였다 → 프롬프트가 보드를 덮은 만큼은 맞춤 영역에서 뺀다
//  R26   '생성 결과' 창이 뜬 채 Ctrl+C 가 뒤 보드의 고른 노드를 복사했다 → 창이 떠 있으면 보드의 복사는 쉰다(규칙 10)
//  R27   그 창에서 카드를 휠(가운데 단추)로 누르면 초점이 보드로 갔다 → 창 안의 누름에는 보드가 초점을 가져가지 않는다
//  R33   끌기 세션 — 단추를 다 뗀 채 온 움직임은 놓친 mouseup 이다(보드에서 보는 시험은 sceneCardGroupMove.test.tsx)
//  R42-c 글자 c 의 자동 연결이 단축키 재지정과 무관하게 고정이었다 → 연결 키(boardConnect)에 건다
import { act, StrictMode, type ComponentProps } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSceneDragSession } from "../src/lib/sceneDragSession";
import type { Scene } from "../src/lib/scenes";
import type { Generation } from "../src/types";
import { createRenderRoot, installPromptBoundaryMocks, mountPrompt, settle } from "./seedanceRenderHarness";

vi.mock("virtua", async () => {
  const { forwardRef, useImperativeHandle } = await import("react");
  return { Virtualizer: forwardRef((props: { data: unknown[]; children: (row: unknown) => React.ReactNode }, ref) => {
    useImperativeHandle(ref, () => ({ scrollToIndex: () => {} }));
    return <>{props.data.map(props.children)}</>;
  }) };
});

type BoardProps = ComponentProps<typeof import("../src/components/scene/SceneBoard").SceneBoard>;
const gen = (id: string, order: number): Generation => ({
  id, status: "done", prompt: id, tags: [], auto_tags: [], references: [], shared: false, deleted: false, is_mine: true,
  comment_count: 0, has_unread: false, created_at: `2026-10-11 00:00:0${9 - order}`, sort_ts: 1000 - order,
  assets: [{ id: `asset-${id}`, generation_id: id, type: "image", file_path: `/${id}.png`, thumbnail_path: null, source_url: null, cached: true }],
} as Generation);
const resultScene: Scene = {
  id: "round7", name: "7회차", created_at: 1, edges: [],
  cards: [{ id: "results", kind: "generation", x: 0, y: 0, genId: "a", genIds: ["a", "b"] }],
};
let view: ReturnType<typeof createRenderRoot>;
let boundary: ReturnType<typeof installPromptBoundaryMocks>;

const boardEl = () => view.container.querySelector<HTMLElement>(".scene-board")!;
const boardCard = (id: string) => view.container.querySelector<HTMLElement>(`.scene-card[data-id="${id}"]`)!;
const windowEl = () => view.container.querySelector<HTMLElement>(".scene-varwin");
const grid = () => view.container.querySelector<HTMLElement>(".scene-varwin .gen-grid")!;
const cell = (id: string) => view.container.querySelector<HTMLElement>(`.scene-varwin .gen-cell[data-id="${id}"]`)!;
const key = (target: EventTarget, init: KeyboardEventInit) => {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  act(() => { target.dispatchEvent(event); });
  return event;
};
// 보드의 카드 고르기 = 누르고(mousedown) 떼기(window mouseup)
const pickBoardCard = (id: string) => act(() => {
  boardCard(id).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
  window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
});

async function mountBoard(scene: Scene, gens: Generation[] = [], props: Partial<BoardProps> = {}) {
  boundary.api.getGenerationsBatch.mockResolvedValue({
    materials: {}, missing: [], items: Object.fromEntries(gens.map((item) => [item.id, item])),
  } as never);
  const { SceneBoard } = await import("../src/components/scene/SceneBoard");
  act(() => view.root.render(<StrictMode><SceneBoard scene={scene} onChange={() => {}} {...props} /></StrictMode>));
  await settle();
}
async function openResults() {
  const badge = [...view.container.querySelectorAll("button")].find((el) => el.textContent === `▤ ${resultScene.cards[0].genIds!.length}`);
  expect(badge, "결과 수 배지").toBeTruthy();
  act(() => { badge!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await settle();
  expect(windowEl(), "결과 창").toBeTruthy();
}

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
  delete (navigator as { clipboard?: unknown }).clipboard;
  vi.unstubAllGlobals();
});

// ── R26 ──
it("'생성 결과' 창이 떠 있으면 Ctrl+C 가 뒤 보드의 고른 노드를 복사하지 않는다 — 창을 닫으면 다시 복사한다", async () => {
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } }); // 보드의 노드 복사는 클립보드에 표식을 쓴다
  await mountBoard(resultScene, [gen("a", 0), gen("b", 1)]);
  pickBoardCard("results");
  expect(boardCard("results").classList.contains("sel")).toBe(true);
  const copy = (target: EventTarget) => key(target, { key: "c", code: "KeyC", ctrlKey: true }).defaultPrevented;

  expect(copy(document.body)).toBe(true); // 전제: 창이 없으면 보드가 받아 복사한다
  expect(writeText).toHaveBeenCalledTimes(1);

  await openResults();
  expect(copy(document.body)).toBe(false); // 가려진 보드는 받지 않는다 — 브라우저의 복사(창 안에서 고른 글자)는 그대로
  expect(copy(grid())).toBe(false);
  expect(writeText).toHaveBeenCalledTimes(1);

  key(document.body, { key: "Escape" }); // 창을 닫는다(창 안에 고른 것이 없다)
  expect(windowEl()).toBeNull();
  expect(boardCard("results").classList.contains("sel")).toBe(true);
  expect(copy(document.body)).toBe(true);
  expect(writeText).toHaveBeenCalledTimes(2);
});

it("창 없이 '결과 창 열림' 상태만 남은 경우에는 Ctrl+C 가 막히지 않는다 — 쉬는 기준은 화면에 뜬 창이다", async () => {
  // 전부터의 약속: 결과 팝업 상태가 비정상적으로 남아도 노드 복사는 새로 고침 전까지 막히지 않는다(카드 메뉴 상태는 있는데 그릴 결과가 없을 때 등)
  const { useSceneKeyboardShortcuts } = await import("../src/lib/useSceneKeyboardShortcuts");
  type Actions = Parameters<typeof useSceneKeyboardShortcuts>[0];
  const onCopy = vi.fn();
  const actions = new Proxy({ isTextEditing: () => false, isPopupOpen: () => true, isPickerOpen: () => false, selectionCount: () => 2, onCopy },
    { get: (target, name) => (name in target ? target[name as keyof typeof target] : () => { throw new Error(`unexpected action: ${String(name)}`); }) }) as unknown as Actions;
  function Harness() { useSceneKeyboardShortcuts(actions); return null; }
  act(() => view.root.render(<Harness />));
  expect(document.querySelector(".scene-varwin")).toBeNull();
  expect(key(document.body, { key: "c", code: "KeyC", ctrlKey: true }).defaultPrevented).toBe(true);
  expect(onCopy).toHaveBeenCalledTimes(1);
});

// ── R27 ──
it("'생성 결과' 창에서 카드를 휠(가운데 단추)로 눌러도 초점이 보드로 가지 않는다 — 보드를 누르면 전처럼 보드가 초점을 받는다", async () => {
  await mountBoard(resultScene, [gen("a", 0), gen("b", 1)]);
  await openResults();
  act(() => grid().focus());
  expect(document.activeElement).toBe(grid());
  // 격자는 가운데 단추의 기본 동작(자동 스크롤)을 막는다 — 초점 이동도 같이 막혀, 보드가 잡는 단계에서 가져간 초점이 그대로 남았다
  act(() => { cell("a").querySelector(".card")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 1 })); });
  expect(document.activeElement).toBe(grid());

  key(document.body, { key: "Escape" });
  expect(windowEl()).toBeNull();
  pickBoardCard("results");
  expect(document.activeElement).toBe(boardEl());
});

it("'생성 결과' 창의 툴바가 연 태그 패널을 눌러도 초점이 보드로 가지 않는다 — 패널은 body 에 그려지지만 그 누름도 창 안의 누름이다", async () => {
  // 패널은 창의 쌓임 맥락을 벗어나려고 body 에 그린다(R14). React 의 누름은 포털을 지나 보드에 닿는데, 눌린 자리는 DOM 으로는 창 밖이다.
  const { LibraryToolbar } = await import("../src/components/LibraryToolbar");
  const noop = () => {};
  await mountBoard(resultScene, [gen("a", 0), gen("b", 1)], {
    renderVariantToolbar: (count) => (
      <LibraryToolbar
        typeFilter="all" onTypeFilter={noop} scale={1} onScale={noop} fill onToggleFill={noop} layout="grid" onLayout={noop}
        groupByDate={false} onToggleGroupByDate={noop} filtersOpen={false} onToggleFilters={noop} count={count} loading={false}
        failedCount={0} onClearFailed={noop} colorDots={[]} colorFilter={new Set()} onToggleColor={noop} sharedOnly={false}
        onToggleShared={noop} commentOnly={false} onToggleComment={noop} hasUnread={false} tags={["alpha"]} tagFilter={new Set()}
        onSelectTag={noop} onDeleteTag={noop} onClearTags={noop} tagPanelOpen onToggleTagPanel={noop}
      />
    ),
  });
  await openResults();
  const panel = document.querySelector<HTMLElement>(".tag-panel")!;
  expect(panel, "태그 패널").toBeTruthy();
  expect(panel.closest(".scene-varwin")).toBeNull();
  act(() => grid().focus());
  act(() => { panel.querySelector(".tag-panel-list")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 })); });
  expect(document.activeElement).toBe(grid());
});

// ── R6 ──
it("f(맞춤)는 하단 프롬프트가 보드를 덮은 만큼을 빼고 맞춘다 — 고른 카드도 전체 맞춤도 프롬프트 뒤에 놓이지 않는다. 프롬프트를 접으면 보드 전체에 맞춘다", async () => {
  // 보드 1000×800, 프롬프트 도크(.sl-dock)의 위 끝 = 600. 그 밖의 요소는 크기 0.
  const DOCK_TOP = 600;
  let dockBox = [100, DOCK_TOP, 800, 182];
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const [x, y, width, height] = this.matches(".scene-board") ? [0, 0, 1000, 800] : this.matches(".sl-dock") ? dockBox : [0, 0, 0, 0];
    return { x, y, left: x, top: y, width, height, right: x + width, bottom: y + height, toJSON: () => ({}) } as DOMRect;
  });
  const prompt = await mountPrompt({ visible: true }); // 실제 프롬프트 도크 — 클래스 이름(.sl-dockbar·.sl-hidden·.sl-dock)이 바뀌면 여기서 드러난다
  try {
    expect(document.querySelector(".sl-dockbar:not(.sl-hidden) .sl-dock")).toBeTruthy();
    const text = (id: string, x: number) => ({ id, kind: "text", x, y: 0, w: 200, h: 400, text: id });
    await mountBoard({ id: "fit", name: "맞춤", created_at: 1, edges: [], cards: [text("t1", 0), text("t2", 3000)] } as unknown as Scene);
    // 맞춘 뒤 캔버스 좌표 y 0..400(두 카드의 세로 범위)이 화면에서 놓인 자리
    const span = () => {
      const found = /translate[(]([-0-9.]+)px, ([-0-9.]+)px[)] scale[(]([-0-9.]+)[)]/.exec(view.container.querySelector<HTMLElement>(".scene-canvas")!.style.transform)!;
      const [y, z] = [Number(found[2]), Number(found[3])];
      return { top: y, bottom: y + 400 * z, zoom: z };
    };
    const fit = () => { key(document.body, { key: "f", code: "KeyF" }); return span(); };

    pickBoardCard("t1");
    const picked = fit(); // 고른 카드에 맞춤
    expect(picked.bottom).toBeLessThanOrEqual(DOCK_TOP);
    expect((picked.top + picked.bottom) / 2).toBeCloseTo(DOCK_TOP / 2, 5); // 프롬프트 위 영역의 가운데
    expect(picked.zoom).toBeCloseTo((DOCK_TOP * 0.82) / 400, 5); // 그 영역 안에 들어오게 줄인다(상한 1.4 보다 작다)

    key(document.body, { key: "Escape" }); // 선택 해제 → 전체 맞춤
    expect(view.container.querySelectorAll(".scene-card.sel").length).toBe(0);
    const all = fit();
    expect((all.top + all.bottom) / 2).toBeCloseTo(DOCK_TOP / 2, 5);

    // 도크가 보드를 덮지 않으면 보드 전체에 맞춘다 — 도크가 보드 아래에 있거나(겹치지 않음), 아직 그려지지 않아 자리가 0 이다
    const middle = (at: { top: number; bottom: number }) => (at.top + at.bottom) / 2;
    dockBox = [100, 900, 800, 182];
    expect(middle(fit())).toBeCloseTo(400, 5);
    dockBox = [0, 0, 0, 0];
    expect(middle(fit())).toBeCloseTo(400, 5);
    dockBox = [100, DOCK_TOP, 800, 182];

    await prompt.render({ visible: false }); // 프롬프트를 접었다 — 오른쪽 아래 상태 줄만 남는다
    expect(document.querySelector(".sl-dockbar.sl-hidden")).toBeTruthy();
    pickBoardCard("t1");
    const folded = fit();
    expect((folded.top + folded.bottom) / 2).toBeCloseTo(400, 5); // 보드 전체의 가운데
    expect(folded.zoom).toBeCloseTo(1.4, 5);
  } finally {
    prompt.dispose();
  }
});

// ── R42-c ──
it("연결 키를 다른 키로 바꾸면 글자 c 는 더는 자동 연결이 아니다 — 자동 연결은 바꾼 키가 하고(안 걸리면 왼→오른쪽 연결), c 는 새로 지정한 동작을 한다", async () => {
  const shortcuts = await import("../src/lib/shortcuts");
  const { useSceneKeyboardShortcuts } = await import("../src/lib/useSceneKeyboardShortcuts");
  type Actions = Parameters<typeof useSceneKeyboardShortcuts>[0];
  let calls: string[] = [];
  let autoConnects = true; // 자동 연결 규칙에 걸리는 쌍이 있나
  // 이 시험이 보는 액션만 둔다 — 나머지는 불리면 실패한다
  const actions = new Proxy({
    isTextEditing: () => false, isPopupOpen: () => false, isPickerOpen: () => false, selectionCount: () => 2,
    onAutoConnect: () => { calls.push("auto"); return autoConnects; },
    onConnect: () => { calls.push("connect"); },
    onDisable: () => { calls.push("disable"); return true; },
  }, { get: (target, name) => (name in target ? target[name as keyof typeof target] : () => { throw new Error(`unexpected action: ${String(name)}`); }) }) as unknown as Actions;
  function Harness() { useSceneKeyboardShortcuts(actions); return null; }
  act(() => view.root.render(<Harness />));
  const press = (letter: string) => { calls = []; key(document.body, { key: letter, code: `Key${letter.toUpperCase()}` }); return calls; };

  // 기본값: 연결 키 = c
  expect(press("c")).toEqual(["auto"]);
  autoConnects = false;
  expect(press("c")).toEqual(["auto", "connect"]); // 걸리는 규칙이 없으면 왼→오른쪽 연결
  expect(press("x")).toEqual([]);

  act(() => { shortcuts.setBinding("boardConnect", "x"); shortcuts.setBinding("boardDisable", "c"); });
  expect(press("c")).toEqual(["disable"]); // c 는 이제 비활성 키다 — 자동 연결이 가로채지 않는다
  expect(press("x")).toEqual(["auto", "connect"]);
  autoConnects = true;
  expect(press("x")).toEqual(["auto"]);
});

// ── R33: 끌기 세션(순수) — 실제 MouseEvent 로 ──
it("끌기 세션: 단추를 다 뗀 채 온 움직임은 놓친 mouseup 이다 — 앞의 마지막 이동까지만 반영하고 취소 콜백으로 끝낸다(다른 단추가 눌려 있으면 잇는다)", () => {
  const frames: (() => void)[] = [];
  const listening = new Set<string>();
  const session = createSceneDragSession<MouseEvent>({
    addListener: (type, listener) => { listening.add(type); window.addEventListener(type, listener as EventListener); },
    removeListener: (type, listener) => { listening.delete(type); window.removeEventListener(type, listener as EventListener); },
    requestFrame: (callback) => frames.push(callback),
    cancelFrame: (id) => { frames[id - 1] = () => {}; },
  });
  const order: string[] = [];
  const begin = () => session.begin((event) => order.push(`move:${event.clientX}`), () => order.push("up"), () => order.push("cancel"));
  const move = (clientX: number, buttons?: number) => window.dispatchEvent(new MouseEvent("mousemove", { clientX, ...(buttons === undefined ? {} : { buttons }) }));
  const runFrames = () => frames.splice(0).forEach((callback) => callback());

  begin();
  move(10, 1);
  runFrames();
  move(20, 4); // 가운데 단추만(화면 이동) — 눌린 단추가 있으니 끌기는 이어진다
  runFrames();
  move(30, 1); // 아직 반영 전(다음 프레임을 기다린다)
  move(99, 0); // 단추를 다 뗐다 — mouseup 은 오지 않았다
  expect(order).toEqual(["move:10", "move:20", "move:30", "cancel"]); // 뗀 뒤의 자리(99)는 반영하지 않는다
  expect(listening.size).toBe(0);
  move(120, 0);
  window.dispatchEvent(new MouseEvent("mouseup"));
  runFrames();
  expect(order).toEqual(["move:10", "move:20", "move:30", "cancel"]);

  // buttons 를 싣지 않는 이벤트(마우스가 아닌 환경)는 뗀 것으로 읽지 않는다
  begin();
  window.dispatchEvent(Object.assign(new Event("mousemove"), { clientX: 7 }));
  runFrames();
  expect(order.slice(4)).toEqual(["move:7"]);
  session.dispose();
});
