// 캔버스에 친 글이 저장으로 넘어가는 시점 — 실제 SceneBoard 로 본다(2026-10-07).
//
// 왜 필요한가: 씬 저장이 IndexedDB 로 가면서 '창을 닫는 순간의 저장'은 끝난다는 보장이 없어졌다(종전
// localStorage 는 그 자리에서 끝났다). 그런데 입력 저장은 400ms 디바운스라, 계속 치면 끝없이 밀려 저장이
// 한 번도 안 나간 채로 창이 닫힐 수 있었다. 그래서 ① 첫 미저장 입력에서 2초가 지나면 치는 중이어도 내보내고
// ② 창이 가려질 때(닫히기 한 박자 전) 내보낸다.
// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SceneBoard } from "../src/components/scene/SceneBoard";
import type { Scene } from "../src/lib/scenes";
import type { SceneGenDataApi } from "../src/lib/useSceneGenData";

// 바꾸는 것은 생성물 읽기뿐 — SceneBoard·입력·저장 예약은 실제 코드다.
const fixture = vi.hoisted(() => ({ data: null as unknown as SceneGenDataApi }));
vi.mock("../src/lib/useSceneGenData", () => ({ useSceneGenData: () => fixture.data }));

const noop = () => {};
let host: HTMLDivElement;
let root: Root;
let saved: Partial<Scene>[];

beforeEach(() => {
  vi.useFakeTimers();
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
  saved = [];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const scene = { id: "A", name: "A", created_at: 0, edges: [], cards: [{ id: "t1", kind: "text", x: 0, y: 0, text: "처음" }] } as unknown as Scene;
const savedTexts = () => saved.map((patch) => patch.cards?.[0]?.text);

async function openEditor(): Promise<HTMLTextAreaElement> {
  await act(async () => {
    root.render(<SceneBoard scene={scene} onChange={(patch) => saved.push(patch)} />);
  });
  await act(async () => {
    host.querySelector<HTMLElement>(".scene-textview-inline")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  });
  return host.querySelector<HTMLTextAreaElement>("textarea.scene-textnode")!;
}
// React 가 다루는 입력칸은 값을 직접 넣으면 변화를 못 본다 — 원래 setter 로 넣고 input 을 쏜다.
const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
const type = (area: HTMLTextAreaElement, text: string) =>
  act(async () => {
    setValue.call(area, text);
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
const wait = (ms: number) => act(async () => { vi.advanceTimersByTime(ms); });

it("계속 치는 중에도 첫 미저장 입력에서 2초 안에 저장한다", async () => {
  const area = await openEditor();
  // 300ms 간격으로 계속 친다 — 400ms 디바운스만으로는 한 번도 끝나지 못한다.
  for (let i = 0; i < 6; i += 1) {
    await type(area, `글${i}`);
    await wait(300);
  }
  expect(saved).toEqual([]); // 1.8초 — 아직이다(치는 동안 매번 저장하지는 않는다)
  await type(area, "글6");
  await wait(300); // 2.1초
  expect(savedTexts()).toEqual(["글6"]); // 치는 중이어도 2초에서 한 번 내보냈다

  await type(area, "글7"); // 다음 묶음은 다시 평소 디바운스로
  await wait(399);
  expect(saved).toHaveLength(1);
  await wait(1);
  expect(savedTexts()).toEqual(["글6", "글7"]);
});

it("창이 가려지면 디바운스를 기다리지 않고 바로 저장한다", async () => {
  const area = await openEditor();
  await type(area, "가려지기 직전");
  expect(saved).toEqual([]);
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
  try {
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
  } finally {
    delete (document as unknown as { visibilityState?: string }).visibilityState; // 원래(prototype) 값으로
  }
  expect(savedTexts()).toEqual(["가려지기 직전"]);
  await wait(1000);
  expect(saved).toHaveLength(1); // 밀려 있던 타이머가 같은 내용을 또 저장하지 않는다
});
