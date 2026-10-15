// @vitest-environment jsdom
// 캔버스 생성 카드의 폴더 이름표(Jay 14A, 2026-10-15) — 라이브러리 카드 아래 변 가운데의 이름표와 같은 부품·같은 글자를 캔버스의
//  완료 생성 카드에도 단다. 표시만 — 누르는 동작이 없고, 이름표 위의 누름·끌기·더블클릭·휠클릭은 카드가 받는다.
//  생성 중·실패·폴더 없음·지운 생성물에는 안 단다. 라이브러리 이름표 시험은 tests/cardFolderChip.test.tsx.
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SceneBoard } from "../src/components/scene/SceneBoard";
import { closeLayer, nextLayerSeq, openLayer } from "../src/lib/keyGate";
import { GenerationCard as CanvasGenerationCard, type HistPass } from "../src/components/scene/cards/GenerationCard";
import type { Scene } from "../src/lib/scenes";
import type { SceneGenDataApi } from "../src/lib/useSceneGenData";
import type { Generation } from "../src/types";

const fixture = vi.hoisted(() => ({ data: null as unknown as SceneGenDataApi }));
vi.mock("../src/lib/useSceneGenData", () => ({ useSceneGenData: () => fixture.data }));

const noop = () => {};
let host: HTMLDivElement;
let root: Root;
const gen = (over: Partial<Generation> = {}): Generation =>
  ({
    id: "g1", prompt: "p", status: "done", created_at: "2026-10-15", shared: false, is_held: false, is_final: false, is_mine: true,
    deleted: false, tags: [], auto_tags: [], references: [], comment_count: 0, color: null,
    project_id: "p1", project_name: "뻘뻘뻘", folder_path: "ep01/e035/c0010",
    assets: [{ id: "a", generation_id: "g1", type: "image", file_path: "/g1.png", thumbnail_path: "/g1.png", source_url: null, cached: false }],
    ...over,
  }) as unknown as Generation;
const hist = (over: Partial<HistPass> = {}): HistPass => ({
  disabledIds: new Set(), typeFilter: "all", colorFilter: new Set(), tagFilter: new Set(),
  sharedOnly: false, commentOnly: false, finalOnly: false, folderSel: null, sConfirm: null,
  onSClick: noop, onSDouble: noop, onSConfirmYes: noop, onSConfirmNo: noop, ...over,
});
const cardProps = (g: Generation, over: Partial<ComponentProps<typeof CanvasGenerationCard>> = {}): ComponentProps<typeof CanvasGenerationCard> => ({
  card: { id: "c1", kind: "generation", genId: g.id, x: 0, y: 0 }, sel: false, g, showNode: g.status === "done", waiting: false,
  genMissing: false, width: 180, height: 180, fill: true, selectedOnly: false, laneDelta: () => 0, getNodePreview: () => noop,
  hist: hist(),
  actions: { setCardMenu: noop, setCardBatch: noop, orchestrateGenerate: async () => {}, showGenerateBar: false, onOutPortDown: noop, onResizeDown: noop },
  tagEdit: { active: false, hasAutoTags: false, autoTagOptions: [], applyCardTags: noop, applyCardAutoTags: noop, close: noop },
  ...over,
});
const renderCard = (g: Generation, over: Partial<ComponentProps<typeof CanvasGenerationCard>> = {}) =>
  act(() => root.render(<CanvasGenerationCard {...cardProps(g, over)} />));
const chip = () => host.querySelector<HTMLElement>(".card-folder");
const fire = (el: Element, type: string, init: MouseEventInit = {}) => {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  act(() => { el.dispatchEvent(event); });
  return event;
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("BroadcastChannel", undefined);
  vi.stubGlobal("WebSocket", class { constructor() { throw new Error("Unexpected socket in isolated UI test"); } });
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("Unexpected network in isolated UI test"))));
  localStorage.clear(); sessionStorage.clear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("a finished card in a folder carries the library's chip on its bottom edge — same parts, same text, display only", () => {
  renderCard(gen());
  const node = host.querySelector<HTMLElement>(".linb-node")!;
  expect(chip()!.textContent).toBe("e035 c0010"); // 라이브러리 이름표와 같은 글자(끝 두 칸, 아이콘·구분자 없음)
  expect(chip()!.className).toBe("card-folder static"); // static = 누를 수 없음(pointer-events: none — generations.css)
  expect(chip()!.tagName).toBe("SPAN");
  expect(chip()!.parentElement!.className).toBe("card-bottom");
  expect(chip()!.parentElement!.parentElement).toBe(node); // 노드 안 — 고른 노드(z-index 7)에 가려지지 않는다
  expect(node.querySelector(".card-bottom button, .card-bottom svg")).toBeNull();
  expect(node.classList.contains("has-folder")).toBe(true); // 호버 단추 줄을 이름표 위로 올리는 표식(scene.css)
});

it("no chip without a folder, while generating, on failure, or for a deleted generation", () => {
  const none = () => [chip(), host.querySelector(".card-bottom"), host.querySelector(".has-folder")];
  for (const folder_path of [null, "", "  "]) {
    renderCard(gen({ folder_path }));
    expect(host.querySelector(".linb-node")).not.toBeNull();
    expect(none()).toEqual([null, null, null]);
  }
  for (const status of ["running", "pending", "failed"] as const) {
    renderCard(gen({ status }));
    expect(host.querySelector(".linb-node")).toBeNull(); // 결과 카드가 아니다
    expect(none()).toEqual([null, null, null]);
  }
  renderCard(gen(), { waiting: true }); // 상류 comfy 가 도는 중
  expect(none()).toEqual([null, null, null]);
  renderCard(gen({ deleted: true }));
  expect(none()).toEqual([null, null, null]);
  renderCard(gen(), { genMissing: true });
  expect(none()).toEqual([null, null, null]);
});

it("pointer input on the chip is the card's — double click previews, wheel click opens info", () => {
  const onPreview = vi.fn();
  const onInfo = vi.fn();
  renderCard(gen(), { getNodePreview: () => onPreview, hist: hist({ onInfo }) });
  fire(chip()!, "dblclick");
  expect(onPreview).toHaveBeenCalledTimes(1);
  expect(onPreview.mock.calls[0][0].genId).toBe("g1");
  fire(chip()!, "auxclick", { button: 1 });
  expect(onInfo).toHaveBeenCalledTimes(1);
});

it("on the real board, pressing the chip selects the card and opens no window", async () => {
  const g = gen();
  const data = { [g.id]: g };
  fixture.data = { genData: data, genDataRef: { current: data }, setGenData: noop, missingIds: new Set(), disabledIds: new Set(), refParents: {} } as unknown as SceneGenDataApi;
  const scene = { id: "S", name: "S", created_at: 0, edges: [], groups: [], cards: [{ id: "c1", kind: "generation", genId: g.id, x: 110, y: 110 }] } as unknown as Scene;
  await act(async () => { root.render(<SceneBoard scene={scene} onChange={noop} />); });
  const card = host.querySelector<HTMLElement>('.scene-card[data-id="c1"]')!;
  expect(card.classList.contains("sel")).toBe(false);
  await act(async () => {
    chip()!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: 180, clientY: 180 }));
  });
  await act(async () => { window.dispatchEvent(new MouseEvent("mouseup", { button: 0, clientX: 180, clientY: 180 })); });
  expect(card.classList.contains("sel")).toBe(true);
  fire(chip()!, "click");
  expect(document.querySelector(".scene-varpop-backdrop, .folder-peek, [role='dialog']")).toBeNull();
});

// 이름표가 붙은 카드의 우클릭 = 그 폴더의 '폴더 보기' 창(Jay 2026-10-15 — 라이브러리 카드 우클릭과 같은 뜻). 창을 여는 것은 App(onOpenFolder)이다.
//  이름표 없는 카드(폴더 없음·생성 중·지운 것)의 우클릭은 종전 그대로 — 브라우저 메뉴. 우클릭은 카드 고르기를 바꾸지 않는다.
const boardWith = async (gens: Generation[], onOpenFolder?: (g: Generation) => void) => {
  const data = Object.fromEntries(gens.map((g) => [g.id, g]));
  fixture.data = { genData: data, genDataRef: { current: data }, setGenData: noop, missingIds: new Set(), disabledIds: new Set(), refParents: {} } as unknown as SceneGenDataApi;
  const scene = {
    id: "S", name: "S", created_at: 0, edges: [], groups: [],
    cards: gens.map((g, i) => ({ id: `c-${g.id}`, kind: "generation", genId: g.id, x: 110 + 330 * i, y: 110 })),
  } as unknown as Scene;
  await act(async () => { root.render(<SceneBoard scene={scene} onChange={noop} onOpenFolder={onOpenFolder} />); });
};
const cardEl = (id: string) => host.querySelector<HTMLElement>(`.scene-card[data-id="c-${id}"]`)!;
const target = (id: string) => cardEl(id).querySelector<HTMLElement>(".card-folder") ?? cardEl(id).querySelector<HTMLElement>(".linb-node, .scene-card-genbody")!;
// 실제 우클릭의 순서 — 누름(button 2) · 뗌 · contextmenu(윈도는 뗀 뒤에 온다)
const rightClick = async (el: Element, between: () => void = noop) => {
  await act(async () => { el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 2, buttons: 2, clientX: 180, clientY: 180 })); });
  await act(async () => { window.dispatchEvent(new MouseEvent("mouseup", { button: 2, clientX: 180, clientY: 180 })); });
  between();
  const menu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 180, clientY: 180 });
  await act(async () => { el.dispatchEvent(menu); });
  return menu;
};
const selectedCards = () => [...host.querySelectorAll<HTMLElement>(".scene-card.sel")].map((el) => el.dataset.id);

it("right-clicking a card that carries the chip asks for that folder once and keeps the browser menu away; the selection does not move", async () => {
  const onOpenFolder = vi.fn();
  const inFolder = gen({ id: "in-folder" });
  await boardWith([inFolder, gen({ id: "other" })], onOpenFolder);
  expect((await rightClick(target("in-folder"))).defaultPrevented).toBe(true);
  expect(onOpenFolder).toHaveBeenCalledTimes(1);
  expect(onOpenFolder).toHaveBeenCalledWith(inFolder);
  expect(selectedCards()).toEqual([]); // 우클릭은 고르지 않는다

  await act(async () => { target("other").dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: 500, clientY: 180 })); });
  await act(async () => { window.dispatchEvent(new MouseEvent("mouseup", { button: 0, clientX: 500, clientY: 180 })); });
  expect(selectedCards()).toEqual(["c-other"]);
  await rightClick(target("in-folder"));
  expect(onOpenFolder).toHaveBeenCalledTimes(2);
  expect(selectedCards()).toEqual(["c-other"]); // 고른 것은 그대로
});

it("cards without the chip keep the browser menu — no folder, still generating, failed, deleted", async () => {
  const onOpenFolder = vi.fn();
  const cases = [gen({ id: "no-folder", folder_path: null }), gen({ id: "running", status: "running" }), gen({ id: "failed", status: "failed" }), gen({ id: "deleted", deleted: true })];
  await boardWith(cases, onOpenFolder);
  for (const g of cases) {
    expect(cardEl(g.id).querySelector(".card-folder")).toBeNull();
    expect((await rightClick(target(g.id))).defaultPrevented).toBe(false);
  }
  expect(onOpenFolder).not.toHaveBeenCalled();
});

it("a right-click that closes something above the board does not open the folder", async () => {
  const onOpenFolder = vi.fn();
  await boardWith([gen()], onOpenFolder);
  const menu = {};
  openLayer(menu, nextLayerSeq()); // 위에 메뉴가 떠 있다 — 우클릭 누름이 그것을 닫는다
  const event = await rightClick(target("g1"), () => closeLayer(menu));
  expect(event.defaultPrevented).toBe(true);
  expect(onOpenFolder).not.toHaveBeenCalled();
  await rightClick(target("g1")); // 다음 우클릭은 연다
  expect(onOpenFolder).toHaveBeenCalledTimes(1);
});

// 카드 위 단추(.linb-ov)는 mousedown 전파를 막지만 contextmenu 는 통과시킨다 — 가림 기록은 보드의 캡처에서 적어야 한다(Codex 리뷰)
it("the cover record also works on a card's overlay button — a closing right-click there does not open, and a stale record does not block the next one", async () => {
  const onOpenFolder = vi.fn();
  await boardWith([gen()], onOpenFolder);
  const button = () => cardEl("g1").querySelector<HTMLElement>(".linb-ov .ov-info")!;
  const menu = {};
  openLayer(menu, nextLayerSeq());
  await rightClick(button(), () => closeLayer(menu)); // 단추 위의 우클릭이 위 메뉴를 닫는다
  expect(onOpenFolder).not.toHaveBeenCalled();

  const other = {};
  openLayer(other, nextLayerSeq());
  await rightClick(host.querySelector(".scene-board")!, () => closeLayer(other)); // 빈 곳 우클릭으로 닫음 — 기록이 소비되지 않고 남는다
  await rightClick(button()); // 가림 없는 단추 위 우클릭은 연다
  expect(onOpenFolder).toHaveBeenCalledTimes(1);
});

it("the chip's rules add no compositing layers — no backdrop-filter, mask, will-change, transform or animation", () => {
  const strip = (name: string) => readFileSync(new NodeURL(`../src/styles/${name}.css`, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = ["generations", "scene"].flatMap((name) => [...strip(name).matchAll(/([^{}]+)\{([^{}]*)\}/g)])
    .filter(([, selector]) => /card-bottom|card-folder|has-folder/.test(selector));
  expect(rules.length).toBeGreaterThan(0);
  for (const [, selector, body] of rules) {
    expect(body, selector.trim()).not.toMatch(/backdrop-filter|mask|will-change|transform|animation|overflow\s*:\s*auto/);
  }
});

// 65회차 실측 — 안 보이는(opacity 0) 호버 단추에 흐림이 늘 걸려 카드마다 레이어 ~8개, 그 위의 이름표까지 레이어가 됐다(88% 끌기 Layerize 약 2.8배).
//  흐림은 보일 때(호버·초점)만 건다.
it("hover buttons blur only while shown — the always-on rule has no backdrop-filter", () => {
  const css = readFileSync(new NodeURL("../src/styles/history.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => [selector.trim(), body] as const);
  const base = rules.find(([selector]) => selector === ".linb-ov-btn");
  expect(base?.[1]).toBeDefined();
  expect(base![1]).not.toMatch(/backdrop-filter/);
  expect(rules.some(([selector, body]) => selector.includes(".linb-node:hover .linb-ov-btn") && /backdrop-filter/.test(body))).toBe(true);
  // 공유·최종 배지는 배경이 늘 불투명 — 흐림은 보이지 않고 노드마다 레이어만 만든다(Codex 65회차 리뷰)
  expect(rules.filter(([selector]) => selector.startsWith(".linb-sf")).map(([, body]) => body).join("")).not.toMatch(/backdrop-filter/);
});
