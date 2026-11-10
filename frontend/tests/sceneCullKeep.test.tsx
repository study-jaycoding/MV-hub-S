// @vitest-environment jsdom
// 캔버스 끊김 없애기(docs/status/캔버스_끊김없애기_2026-11-11.md) — 실제 SceneBoard 로 본다.
//  · 이력 컬링: 범위 판정(보이는 범위 ± 1500)으로 붙은 카드는 확대해도 보이는 범위의 4배(+ 1500) 밖으로 나가야 뗀다 — 확대 뒤 쉴 때 떼어 낸 카드를
//    다시 축소할 때 그대로 다시 붙여 그 프레임이 끊겼다. 들어오는 기준은 그대로다. 늘 그리는 카드(선택 등)로만 붙었던 카드는 기억하지 않는다.
//  · 캔버스 층의 filter: blur(0px) — 크롬의 그릴 범위를 무한으로 두는 장치(보이는 것은 그대로).
// 화면(보드)은 1000×600, 첫 카메라는 배율 50%·이동 0 → 보이는 범위 0..2000 × 0..1200, 컬링 범위 −1500..3500 × −1500..2700.
//  휠은 (0, 0)에서 굴려 왼쪽 위가 고정된다 — 배율 z 에서 보이는 범위 0..1000/z, 떼는 범위 오른쪽 끝 = 보이는 가운데 + 보이는 폭 × 2 + 1500 = 2500/z + 1500.
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url"; // jsdom 이 전역 URL 을 바꿔 둔다 — 파일 주소는 node 의 URL 로
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SceneBoard } from "../src/components/scene/SceneBoard";
import type { SceneGenDataApi } from "../src/lib/useSceneGenData";

const fixture = vi.hoisted(() => ({ data: null as unknown as SceneGenDataApi }));
vi.mock("../src/lib/useSceneGenData", () => ({ useSceneGenData: () => fixture.data }));

const noop = () => {};
let host: HTMLDivElement;
let root: Root;
let frames: FrameRequestCallback[] = [];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("BroadcastChannel", undefined);
  vi.stubGlobal("WebSocket", class { constructor() { throw new Error("Unexpected socket in isolated UI test"); } });
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("Unexpected network in isolated UI test"))));
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames[id - 1] = noop; });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const [w, h] = this.matches(".scene-board") ? [1000, 600] : [0, 0];
    return { x: 0, y: 0, left: 0, top: 0, width: w, height: h, right: w, bottom: h, toJSON: noop } as DOMRect;
  });
  // jsdom 은 높이가 늘 0 이라 '아직 못 잰 카드는 늘 그린다'(keepIds)에 걸려 컬링이 안 일어난다 — 카드 높이를 흉내 낸다
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.matches(".scene-card") ? 130 : 0;
  });
  localStorage.clear();
  sessionStorage.clear();
  fixture.data = {
    genData: {}, genDataRef: { current: {} }, setGenData: noop, missingIds: new Set(), disabledIds: new Set(), refParents: {},
  } as unknown as SceneGenDataApi;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const textCard = (id: string, x: number, y: number) => ({ id, kind: "text", x, y, w: 152, h: 130, text: id });
const show = (scene: { id: string; cards: object[]; camera?: object }) => act(async () => {
  const value = { name: scene.id, created_at: 0, groups: [], edges: [], camera: { z: 0.5, x: 0, y: 0 }, ...scene } as never;
  root.render(<SceneBoard scene={value} onChange={noop} />);
});
const flush = () => act(async () => { for (let i = 0; i < 4; i++) frames.splice(0).forEach((cb) => cb(0)); });
const board = () => host.querySelector<HTMLElement>(".scene-board")!;
const has = (id: string) => !!host.querySelector(`.scene-card[data-id="${id}"]`);
const zoom = () => +(/scale[(]([-0-9.]+)[)]/.exec(host.querySelector<HTMLElement>(".scene-canvas")!.style.transform)?.[1] ?? 0);
/** (0, 0)에서 휠 n 칸 — 굴린 뒤 쉼 정리(150ms)까지 기다린다 */
async function wheel(n: number, deltaY: number) {
  for (let i = 0; i < n; i++) {
    await act(async () => { board().dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY, clientX: 0, clientY: 0 })); });
    await flush();
  }
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
  await flush();
}
const key = (k: string, ctrl = false) => act(async () => {
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: k, code: k.length === 1 ? `Key${k.toUpperCase()}` : k, ctrlKey: ctrl, bubbles: true, cancelable: true }));
});

it("범위 판정으로 붙은 카드는 확대해도 보이는 범위의 4배 안이면 남고, 그 밖으로 나가면 다음 확정 때 뗀다 — 다시 축소하면 다시 붙는다", async () => {
  // c 는 확대하며 컬링 범위를 나가는 카드 — 그때의 확정(쉼 정리)이 떼는 범위 판정을 다시 돌린다(떼기만을 위해서는 다시 그리지 않는다)
  await show({ id: "S", cards: [textCard("a", 100, 100), textCard("c", 2300, 100), textCard("b", 3300, 100), textCard("far", 4000, 100)] });
  await flush();
  expect([has("a"), has("c"), has("b"), has("far")]).toEqual([true, true, true, false]); // far 는 컬링 범위(…3500) 밖
  // 4칸(약 73%) — 보이는 범위 오른쪽 끝 2000 → 약 1366 으로 확정 문턱(500)을 넘어 쉼 정리가 돈다. 컬링 범위 끝 약 2866 < b(3300), 떼는 범위 끝 약 4915
  await wheel(4, -100);
  expect(zoom()).toBeGreaterThan(0.73);
  expect([has("a"), has("c"), has("b"), has("far")]).toEqual([true, true, true, false]); // 쉼 정리 뒤에도 b 는 남는다(전에는 뗐다)
  await wheel(7, -100); // 약 143% — 컬링 범위 끝 약 2200 < c(2300)라 확정이 돈다 · 떼는 범위 끝 약 3250: c 는 안, b 는 밖
  expect(zoom()).toBeGreaterThan(1.4);
  expect([has("a"), has("c"), has("b")]).toEqual([true, true, false]);
  await wheel(11, 100); // 다시 50% — b 는 들어오는 기준(컬링 범위)으로 다시 붙는다
  expect([has("a"), has("c"), has("b"), has("far")]).toEqual([true, true, true, false]);
});

it("늘 그리는 카드(선택)로만 붙었던 카드는 기억하지 않는다 — 선택을 풀면 컬링 범위 밖이라 뗀다", async () => {
  await show({ id: "S", cards: [textCard("a", 100, 100), textCard("s", 3700, 100)] });
  await flush();
  expect(has("s")).toBe(false);
  await key("a", true);
  await flush();
  expect(has("s")).toBe(true);
  await key("Escape");
  await flush();
  expect(has("s")).toBe(false); // 떼는 범위(…5500) 안이지만 범위 판정으로 붙은 적이 없다
});

it("씬을 바꾸면 옛 씬에서 붙었던 기억을 쓰지 않는다 — 바꾼 직후 옛 씬의 보이는 범위로 잰 것도 기억하지 않는다", async () => {
  await show({ id: "S", cards: [textCard("x", 3300, 100)] });
  await flush();
  expect(has("x")).toBe(true);
  // 2칸(약 60%) — 확정 문턱 안이라 확정 범위는 50% 의 것(컬링 끝 3500, x 안)으로 남는다
  await wheel(2, -100);
  expect(has("x")).toBe(true);
  // 같은 id 의 카드가 있는 새 씬을 지금 배율로 연다 — 새 씬에서는 들어오는 기준(새로 잰 컬링 범위 …약 3150, x 밖)으로만 정한다.
  //  바꾼 직후의 그리기는 옛 씬의 확정 범위(…3500)를 잠깐 쓰는데, 그때 들어온 x 를 새 씬의 기억으로 남기면 떼는 범위(…약 5630) 덕에 남는다
  const z = zoom();
  await show({ id: "S2", cards: [textCard("x", 3300, 100)], camera: { z, x: 0, y: 0 } });
  await flush();
  await flush();
  expect(has("x")).toBe(false);
});

it("캔버스 층에 filter: blur(0px) 를 건다 — 크롬의 그릴 범위를 무한으로 두는 장치", () => {
  const css = readFileSync(new NodeURL("../src/styles/scene.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((m) => m[1].trim() === ".scene-canvas");
  expect(rule?.[2]).toMatch(/filter: blur\(0px\)/);
});
