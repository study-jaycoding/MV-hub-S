// @vitest-environment jsdom
// 가운데 버튼으로 끄는 동안 '새로 그려야 할 것이 생길 때만' 컬링 범위를 확정한다(2026-11-10) — 실제 SceneBoard 로 본다.
//  · 새로 들어오는 카드·선이 없으면 끄는 동안 SceneBoard 를 다시 그리지 않는다(0단계 격리 실측: 그릴 대상이 그대로인 다시 그리기가
//    끄는 동안 덜컥거림의 큰 몫이었다).
//  · 그래도 빠지는 것은 없어야 한다: 카드가 들어오면 그린다 · 선만 들어와도 그린다 · 건너뛴 뒤 선택을 풀어도 화면 안 카드가 남는다 ·
//    카메라가 같은 씬으로 바꿔도 새 씬의 카드를 그린다.
// 화면(보드)은 1000×600, 첫 카메라는 확대 100%·이동 0 → 보이는 범위 0..1000 × 0..600, 컬링 범위는 ±1500(−1500..2500 × −1500..2100).
import { act, Profiler } from "react";
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
let commits = 0;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("BroadcastChannel", undefined);
  vi.stubGlobal("WebSocket", class { constructor() { throw new Error("Unexpected socket in isolated UI test"); } });
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("Unexpected network in isolated UI test"))));
  frames = [];
  commits = 0;
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
const show = (scene: { id: string; cards: object[]; edges?: object[]; camera?: object }) => act(async () => {
  const value = { name: scene.id, created_at: 0, groups: [], edges: [], ...scene } as never;
  root.render(
    <Profiler id="board" onRender={() => { commits++; }}>
      <SceneBoard scene={value} onChange={noop} />
    </Profiler>,
  );
});
const flush = () => act(async () => { for (let i = 0; i < 4; i++) frames.splice(0).forEach((cb) => cb(0)); });
const board = () => host.querySelector<HTMLElement>(".scene-board")!;
const has = (id: string) => !!host.querySelector(`.scene-card[data-id="${id}"]`);
const press = (x: number, y: number) => act(async () => {
  board().dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 1, clientX: x, clientY: y }));
});
// 가운데 단추를 누른 채 움직인다 — 끌기 세션의 rAF 와 보이는 범위 계산의 rAF 를 함께 돌린다
const panTo = async (x: number, y: number) => {
  await act(async () => { window.dispatchEvent(new MouseEvent("mousemove", { clientX: x, clientY: y, buttons: 4 })); });
  await flush();
};
const lift = async (x: number, y: number) => {
  await act(async () => { window.dispatchEvent(new MouseEvent("mouseup", { button: 1, clientX: x, clientY: y })); });
  await flush();
};
const key = (k: string, ctrl = false) => act(async () => {
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: k, code: k.length === 1 ? `Key${k.toUpperCase()}` : k, ctrlKey: ctrl, bubbles: true, cancelable: true }));
});

it("새로 들어오는 카드가 없으면 끄는 동안 다시 그리지 않고, 카드가 들어오면 그린다", async () => {
  await show({ id: "S", cards: [textCard("near", 100, 100), textCard("far", 3600, 100)] });
  await flush();
  expect([has("near"), has("far")]).toEqual([true, false]); // far 는 컬링 범위(…2500) 밖
  await press(500, 300);
  await panTo(450, 300); // 4px 넘게 — 끌기 시작
  commits = 0;
  for (const x of [350, 200, 50, -100, -200]) await panTo(x, 300); // 700px 왼쪽으로 — 범위는 문턱(500)을 넘지만 far 는 아직 밖(…3200)
  expect(commits).toBe(0);
  expect(has("far")).toBe(false);
  for (const x of [-450, -650]) await panTo(x, 300); // 1150px — 컬링 범위 오른쪽 끝 3650 ≥ far(3600)
  expect(has("far")).toBe(true);
  await lift(-650, 300);
  expect([has("near"), has("far")]).toEqual([true, true]);
});

it("카드는 그대로여도 연결선만 새로 들어오면 그린다", async () => {
  // 두 카드 모두 컬링 범위 밖(왼쪽 −2600, 오른쪽 2600), 선은 아래쪽 y≈2265 — 위로 700px 끌면 범위 아래 끝(2100 → 2800)에 들어온다
  await show({
    id: "S",
    cards: [textCard("a", -2600, 2200), { id: "g", kind: "generation", x: 2600, y: 2200, w: 152, h: 130 }],
    edges: [{ id: "e1", from: "a", to: "g", role: "text" }],
  });
  await flush();
  const edgeDrawn = () => !!host.querySelector('.scene-edges path[d]:not([d=""])');
  expect([has("a"), has("g"), edgeDrawn()]).toEqual([false, false, false]);
  await press(500, 300);
  await panTo(500, 250);
  for (const y of [150, 0, -150, -300, -400]) await panTo(500, y); // 700px — 범위 문턱(500)을 넘고, 아래 끝 2100 → 2800
  expect(edgeDrawn()).toBe(true);
  expect([has("a"), has("g")]).toEqual([false, false]); // 카드는 여전히 밖(가로로 −1500..2500 밖)
  await lift(500, -400);
});

it("끄는 동안 확정을 건너뛴 뒤 선택을 풀어도 화면 근처의 카드가 빠지지 않는다", async () => {
  // sel 은 처음 컬링 범위 밖(3000)이지만 전체 선택으로 늘 그리는 카드다. 700px 끌면 최신 범위(…3200) 안 — 그동안 들어오는 다른
  //  카드가 없어 확정은 건너뛴다. 선택을 풀면 늘 그리기에서 빠지는데, 낡은 확정 범위(…2500)로 거르면 사라진다 → 다시 판정해 확정해야 한다.
  await show({ id: "S", cards: [textCard("near", 100, 100), textCard("sel", 3000, 100)] });
  await flush();
  expect(has("sel")).toBe(false);
  await key("a", true);
  await flush();
  expect(has("sel")).toBe(true); // 고른 카드는 늘 그린다
  await press(500, 300);
  await panTo(450, 300);
  commits = 0;
  for (const x of [350, 200, 50, -100, -200]) await panTo(x, 300);
  expect(commits).toBe(0);
  await lift(-200, 300);
  await key("Escape");
  await flush();
  expect(has("sel")).toBe(true);
});

it("카메라가 같은 씬으로 바꿔도 새 씬의 카드를 그린다", async () => {
  await show({ id: "S", cards: [textCard("near", 100, 100)] });
  await flush();
  await press(500, 300);
  await panTo(450, 300);
  for (const x of [350, 200, 50, -100, -200]) await panTo(x, 300); // 카메라 x −700, 확정은 건너뜀
  await lift(-200, 300);
  // 새 씬은 지금 카메라와 같은 자리에서 열리고, 카드는 옛 확정 범위(…2500) 밖·지금 범위(…3200) 안
  await show({ id: "S2", cards: [textCard("c2", 2800, 100)], camera: { z: 1, x: -700, y: 0 } });
  await flush();
  await flush();
  expect(has("c2")).toBe(true);
});
