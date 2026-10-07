// @vitest-environment jsdom
// 캔버스 '생성 결과' 창 — 라이브러리 격자·카드로 다시 지은 창(2026-10-07)이 지켜야 하는 약속. 실제 SceneBoard + 실제 격자·카드로 본다.
//  ① 툴바 필터에 가려진 결과는 창에서 빠지고 **선택에서도** 빠진다(가려진 카드가 같이 지워지면 안 된다)
//  ② Esc 는 선택부터 풀고, 선택이 없을 때 창을 닫는다 — 격자에 초점이 있어도 한 번에 둘 다 하지 않는다
//  ③ 여러 장을 고른 채 한 카드에서 한 조작(태그·S)은 고른 전체에 걸린다
//  ④ 카드의 공유는 씬의 사본에 바로 보이고 App 핸들러로 나간다
//  ⑤ 폴더에 든 결과는 폴더 표를 달고, 캔버스에서 고른 폴더 밖의 결과는 흐리다
import { act, StrictMode, useState, type ComponentProps } from "react";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Scene } from "../src/lib/scenes";
import type { Generation } from "../src/types";
import { createRenderRoot, installPromptBoundaryMocks, settle } from "./seedanceRenderHarness";

vi.mock("virtua", async () => {
  const { forwardRef, useImperativeHandle } = await import("react");
  return { Virtualizer: forwardRef((props: { data: unknown[]; children: (row: unknown) => React.ReactNode }, ref) => {
    useImperativeHandle(ref, () => ({ scrollToIndex: () => {} }));
    return <>{props.data.map(props.children)}</>;
  }) };
});

type BoardProps = ComponentProps<typeof import("../src/components/scene/SceneBoard").SceneBoard>;
const scene: Scene = {
  id: "variant-scene", name: "결과 창", created_at: 1, edges: [],
  cards: [{ id: "results", kind: "generation", x: 0, y: 0, genId: "a", genIds: ["a", "b", "c"] }],
};
// 최신순으로 a, b, c — 창은 최근 것부터 그린다
const gen = (id: string, order: number, patch: Partial<Generation> = {}): Generation => ({
  id, status: "done", prompt: id, tags: [], auto_tags: [], references: [], shared: false, deleted: false, is_mine: true,
  comment_count: 0, has_unread: false, created_at: `2026-10-07 00:00:0${9 - order}`, sort_ts: 1000 - order,
  assets: [{ id: `asset-${id}`, generation_id: id, type: "image", file_path: `/${id}.png`, thumbnail_path: null, source_url: null, cached: true }],
  ...patch,
} as Generation);
let view: ReturnType<typeof createRenderRoot>;
let boundary: ReturnType<typeof installPromptBoundaryMocks>;
let setProps!: (patch: Partial<BoardProps>) => void;

const windowEl = () => view.container.querySelector<HTMLElement>(".scene-varwin");
const cells = () => [...view.container.querySelectorAll<HTMLElement>(".scene-varwin .gen-cell")];
const shownIds = () => cells().map((cell) => cell.dataset.id);
const selectedIds = () => cells().filter((cell) => cell.querySelector(".card.selected")).map((cell) => cell.dataset.id);
const cell = (id: string) => view.container.querySelector<HTMLElement>(`.scene-varwin .gen-cell[data-id="${id}"]`)!;
const grid = () => view.container.querySelector<HTMLElement>(".scene-varwin .gen-grid")!;
// 격자의 선택 = 누르고(mousedown) 떼기(window mouseup)
const pick = (id: string, options: MouseEventInit = {}) => act(() => {
  cell(id).querySelector(".card")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, ...options }));
  window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
});
const key = (target: EventTarget, init: KeyboardEventInit) => act(() => {
  target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
});
const wait = (ms: number) => act(async () => { await new Promise((done) => setTimeout(done, ms)); });

async function openWindow(gens: Generation[], props: Partial<BoardProps> = {}) {
  boundary.api.getGenerationsBatch.mockResolvedValue({
    materials: {}, missing: [], items: Object.fromEntries(gens.map((item) => [item.id, item])),
  } as never);
  // 공유·최종 뒤 씬이 그 한 건을 다시 읽는다 — 서버 기록 그대로(이 시험의 공유 콜백은 서버를 바꾸지 않는다)
  boundary.api.getGeneration.mockImplementation((async (id: string) => gens.find((item) => item.id === id)) as never);
  const { SceneBoard } = await import("../src/components/scene/SceneBoard");
  function Host() {
    const [extra, setExtra] = useState(props);
    setProps = (patch) => setExtra((previous) => ({ ...previous, ...patch }));
    return <SceneBoard scene={scene} onChange={() => {}} {...extra} />;
  }
  act(() => view.root.render(<StrictMode><Host /></StrictMode>));
  await settle();
  const badge = [...view.container.querySelectorAll("button")].find((el) => el.textContent === `▤ ${scene.cards[0].genIds!.length}`);
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
  vi.unstubAllGlobals();
});

it("필터에 가려진 결과는 창에서 빠지고 선택에서도 빠진다 — 다시 보여도 골라져 있지 않다 · 지운 결과는 그리지 않는다", async () => {
  await openWindow([gen("a", 0, { tags: ["keep"] }), gen("b", 1), gen("c", 2, { deleted: true })]);
  expect(shownIds()).toEqual(["a", "b"]); // 지운 c 는 없다
  expect(windowEl()!.querySelector(".folder-peek-title")!.textContent).toBe("생성 결과 3개");
  expect(windowEl()!.querySelector(".folder-peek-count")!.textContent).toBe("2개 표시");
  pick("a");
  pick("b", { ctrlKey: true });
  expect(selectedIds()).toEqual(["a", "b"]);

  act(() => setProps({ tagFilter: new Set(["keep"]) }));
  await settle();
  expect(shownIds()).toEqual(["a"]);
  expect(selectedIds()).toEqual(["a"]);

  act(() => setProps({ tagFilter: undefined }));
  await settle();
  expect(shownIds()).toEqual(["a", "b"]);
  expect(selectedIds()).toEqual(["a"]); // 가려진 동안 선택에서 빠졌다 — 되돌아와도 고른 적 없는 카드다
});

it("다빈치가 고른 결과는 필터에 안 맞아도 보인다 — 직접 고르면 그 표시가 풀리며 다시 가려진다", async () => {
  await openWindow([gen("a", 0, { tags: ["keep"] }), gen("b", 1)], { tagFilter: new Set(["keep"]) });
  expect(shownIds()).toEqual(["a"]);
  act(() => setProps({ resolveSelection: { sceneId: scene.id, generationId: "b", nonce: 1, at: Date.now(), openPopup: true },
    onResolveSelectionConsumed: () => setProps({ resolveSelection: null }) }));
  await settle();
  expect(shownIds()).toEqual(["a", "b"]);
  expect(selectedIds()).toEqual(["b"]);
  expect(cell("b").querySelector(".card.resolve-highlighted")).toBeTruthy();
  pick("a");
  await settle();
  expect(shownIds()).toEqual(["a"]);
  expect(selectedIds()).toEqual(["a"]);
});

it("Esc 는 선택부터 풀고 선택이 없을 때 창을 닫는다 — 격자에 초점이 있어도 한 번에 둘 다 하지 않는다", async () => {
  await openWindow([gen("a", 0), gen("b", 1)]);
  // 실제 브라우저에서는 격자의 키 처리(React)가 끝나면 그 상태 변경이 **window 리스너가 돌기 전에** 화면에 반영된다 — 그래서 씬
  //  단축키가 볼 때는 선택이 이미 비어 있다. jsdom 의 act 는 반영을 미루므로, 문서 리스너에서 강제로 반영해 같은 순서를 만든다
  //  (이게 없으면 '격자가 쓴 Esc 를 씬이 또 처리'하는 병이 시험에서 안 드러난다 — 되돌려 확인으로 확인, 2026-10-07).
  const commitBetweenListeners = () => flushSync(() => {});
  document.addEventListener("keydown", commitBetweenListeners);
  try {
  // 초점이 격자 밖(툴바 단추 등): 씬 단축키가 받는다
  pick("a");
  key(document.body, { key: "Escape" });
  expect(selectedIds()).toEqual([]);
  expect(windowEl()).toBeTruthy();
  // 초점이 격자: 격자가 선택을 풀고, 같은 Esc 가 창까지 닫지 않는다
  pick("b");
  key(grid(), { key: "Escape" });
  expect(selectedIds()).toEqual([]);
  expect(windowEl()).toBeTruthy();
  // 위에 뜬 창(정보)이 Esc 를 받는 중이면 씬은 손대지 않는다
  act(() => setProps({ escBlocked: true }));
  key(document.body, { key: "Escape" });
  expect(windowEl()).toBeTruthy();
  act(() => setProps({ escBlocked: false }));
  // 선택이 없으면 닫는다 — 격자에 초점이 있어도
  key(grid(), { key: "Escape" });
  expect(windowEl()).toBeNull();
  } finally {
    document.removeEventListener("keydown", commitBetweenListeners);
  }
});

it("여러 장을 고르고 한 카드에 태그를 달면 고른 전체에 달린다 — 고르지 않은 카드는 그대로", async () => {
  const onSetTags = vi.fn();
  await openWindow([gen("a", 0), gen("b", 1, { tags: ["old"] }), gen("c", 2)], { onSetTags });
  pick("a");
  pick("b", { ctrlKey: true }); // 마지막에 누른 b 가 기준 카드
  key(grid(), { key: "#" });
  const input = cell("b").querySelector<HTMLInputElement>("input.cs-tag-input");
  expect(input, "기준 카드의 태그 입력").toBeTruthy();
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "new");
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
  key(input!, { key: "Enter" });
  await settle();
  const saved = Object.fromEntries(onSetTags.mock.calls.map(([target, tags]) => [(target as Generation).id, tags]));
  expect(saved).toEqual({ a: ["new"], b: ["old", "new"] }); // c 는 부르지 않는다
  expect(onSetTags).toHaveBeenCalledTimes(2); // 기준 카드는 편집기가 한 번만 쓴다(일괄에서 또 쓰지 않는다)
});

it("여러 장을 고르고 한 카드의 S 를 누르면 고른 전체가 등급 확인으로 넘어간다", async () => {
  const onVariantGradeStep = vi.fn();
  await openWindow([gen("a", 0), gen("b", 1), gen("c", 2)], { onVariantGradeStep });
  pick("a");
  pick("c", { ctrlKey: true });
  act(() => { cell("a").querySelector(".card-sf")!.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })); });
  await wait(300); // 단일/더블 클릭 구분(220ms)
  expect(onVariantGradeStep).toHaveBeenCalledTimes(1);
  const [gens, mode] = onVariantGradeStep.mock.calls[0];
  expect((gens as Generation[]).map((item) => item.id)).toEqual(["a", "c"]);
  expect(mode).toBe("single");
});

it("카드의 S 로 공유하면 씬의 사본에 바로 보이고 App 의 공유로 나간다", async () => {
  const onPublish = vi.fn();
  await openWindow([gen("a", 0), gen("b", 1)], { onPublish });
  expect(cell("a").querySelector(".card-sf.on")).toBeNull();
  act(() => { cell("a").querySelector(".card-sf")!.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })); });
  await wait(300);
  const yes = cell("a").querySelector<HTMLButtonElement>(".cs-final-yes");
  expect(yes, "공유 확인").toBeTruthy();
  act(() => yes!.click());
  expect(onPublish).toHaveBeenCalledTimes(1);
  expect((onPublish.mock.calls[0][0] as Generation).id).toBe("a");
  expect(cell("a").querySelector(".card-sf.on")).toBeTruthy(); // 서버 답을 기다리지 않고 바로
});

it("폴더에 든 결과는 폴더 표를 달고(누르는 단추가 아니다), 캔버스에서 고른 폴더 밖의 결과는 흐리다", async () => {
  await openWindow(
    [gen("a", 0, { project_id: "p1", folder_path: "ep01/shot010" }), gen("b", 1, { project_id: "p1", folder_path: "ep02/shot020" }), gen("c", 2)],
    { folderSel: { projectId: "p1", path: "ep01" } },
  );
  const chip = cell("a").querySelector<HTMLElement>(".card-folder");
  expect(chip!.textContent).toBe("ep01 shot010");
  expect(chip!.tagName).toBe("SPAN");
  expect(chip!.classList.contains("static")).toBe(true);
  expect(cell("c").querySelector(".card-folder")).toBeNull(); // 폴더에 없는 결과
  const dimmed = () => cells().filter((item) => item.querySelector(".card.folder-dim")).map((item) => item.dataset.id);
  expect(dimmed()).toEqual(["b", "c"]);
  act(() => setProps({ folderSel: null }));
  await settle();
  expect(dimmed()).toEqual([]);
});

// ── Codex 코드 리뷰(2026-10-07)에서 나온 경로 ──
it("여러 장을 고르고 한 카드에서 워크스페이스 명령을 내리면 고른 전체가 대상으로 나간다 — 묶음 밖 카드에서 내리면 그 카드만", async () => {
  // 편집기는 '선택된 카드 전역/워크스페이스 적용'이라고 안내한다 — 한 장만 바뀌면 안내와 다르다
  Object.assign(boundary.api, { workspaceCommandOptions: vi.fn().mockResolvedValue({ workspaces: [{ id: "w1", name: "W1" }] }) });
  const onWorkspaceCommand = vi.fn().mockResolvedValue(true);
  await openWindow([gen("a", 0), gen("b", 1), gen("c", 2)], { onWorkspaceCommand, onSetTags: vi.fn(), onSetAutoTags: vi.fn() });
  const command = async (id: string) => {
    key(grid(), { key: "#" });
    const input = cell(id).querySelector<HTMLInputElement>("input.cs-tag-input")!;
    expect(input, `${id} 의 태그 입력`).toBeTruthy();
    key(input, { key: "#" }); // 전역(##) 모드
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "#+");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();
    const option = cell(id).querySelector<HTMLElement>(".te-wchip");
    expect(option, "워크스페이스 선택지").toBeTruthy();
    act(() => { option!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 })); });
    await settle();
  };
  pick("a");
  pick("c", { ctrlKey: true }); // 기준 카드 c
  await command("c");
  expect(onWorkspaceCommand).toHaveBeenCalledTimes(1);
  const [focus, operation, workspace, targets] = onWorkspaceCommand.mock.calls[0];
  expect([(focus as Generation).id, operation, (workspace as { id: string }).id]).toEqual(["c", "assign", "w1"]);
  expect((targets as Generation[]).map((item) => item.id)).toEqual(["a", "c"]);
  // 고른 묶음(a·c) 밖의 카드 b 에서 내리면 그 카드만 — 보이지 않는 선택 전체가 따라 바뀌면 안 된다(대상 목록을 넘기지 않는다)
  const stillOpen = windowEl()!.querySelector<HTMLInputElement>("input.cs-tag-input"); // 편집기가 열려 있으면 닫는다
  if (stillOpen) key(stillOpen, { key: "Escape" });
  pick("b", { ctrlKey: true });
  pick("b", { ctrlKey: true }); // 다시 눌러 선택에서 뺀다 — 기준(초점)은 b 에 남는다
  expect(selectedIds()).toEqual(["a", "c"]);
  await command("b");
  expect(onWorkspaceCommand).toHaveBeenCalledTimes(2);
  expect((onWorkspaceCommand.mock.calls[1][0] as Generation).id).toBe("b");
  expect(onWorkspaceCommand.mock.calls[1][3]).toBeUndefined();
});

it("아직 불러오지 못한 결과는 선택에 남아 있어도 조작 대상이 아니다 — 창의 선택 수에도 안 들어간다", async () => {
  // c 는 서버 응답에 없다(삭제됐거나 아직 안 옴). 다빈치가 a·c 를 골랐다.
  await openWindow([gen("a", 0), gen("b", 1)], {
    resolveSelection: { sceneId: scene.id, generationId: "a", generationIds: ["a", "c"], selectedCount: 2, nonce: 1, at: Date.now(), openPopup: true },
  });
  expect(shownIds()).toEqual(["a", "b"]);
  expect(selectedIds()).toEqual(["a"]);
  key(document.body, { key: "d" }); // 비활성 — 보이는 a 에만
  const { loadDisabledGen } = await import("../src/lib/deactivated");
  expect([...loadDisabledGen()]).toEqual(["a"]);
});

it("결과 창이 떠 있으면 바깥에서 시작한 끌기 선택은 창의 격자만 받는다 — 뒤 캔버스의 범위 선택은 시작하지 않는다", async () => {
  await openWindow([gen("a", 0), gen("b", 1)]);
  const boardMarquee = view.container.querySelector<HTMLElement>(".scene-marquee")!;
  expect(boardMarquee.hidden).toBe(true);
  // 상단바 여백처럼 창·보드 어느 쪽에도 속하지 않는 곳
  const outside = document.createElement("div");
  document.body.append(outside);
  try {
    act(() => {
      outside.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX: 10, clientY: 10 }));
      window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 120, clientY: 140 }));
    });
    await act(async () => { await new Promise<void>((done) => requestAnimationFrame(() => done())); });
    expect(windowEl()!.querySelector(".assets-marquee")).toBeTruthy(); // 창의 격자가 받았다
    expect(boardMarquee.hidden).toBe(true); // 캔버스는 안 받았다
  } finally {
    act(() => { window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); });
    outside.remove();
  }
});

it("'태그 저장 끝' 알림을 받으면 씬의 사본을 서버 값으로 다시 읽는다 — 저장에 실패한 태그가 창에 남지 않는다", async () => {
  await openWindow([gen("a", 0, { tags: ["unsaved"] }), gen("b", 1)]);
  expect(cell("a").querySelector(".card-cm.on")).toBeTruthy(); // T 가 켜져 있다(낙관적으로 붙인 태그)
  // 서버에는 그 태그가 없다(저장 실패)
  boundary.api.getGenerationsBatch.mockResolvedValue({ materials: {}, missing: [], items: { a: gen("a", 0), b: gen("b", 1) } } as never);
  const { APP_EVENTS } = await import("../src/lib/appEvents");
  act(() => { window.dispatchEvent(new CustomEvent(APP_EVENTS.generationTagsSettled)); });
  await wait(450); // 씬의 다시 읽기는 0.3초 모아서 한 번
  await settle();
  expect(cell("a").querySelector(".card-cm.on")).toBeNull();
});
