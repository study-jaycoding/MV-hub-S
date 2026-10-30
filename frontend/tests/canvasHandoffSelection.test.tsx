// 휠 클릭으로 연 캔버스 창은 메인 캔버스에서 고른 카드·그룹으로 시작한다(2026-10-30 Jay "선택도 넘긴다",
// docs/status/캔버스_창_선택넘기기_2026-10-30.md) — 실제 SceneBoard 로 본다(sceneSwitchReset 과 같은 준비).
// 넘긴 값을 한 번 읽어 두는 곳(lib/popupWindows)이 모듈 전역이라 시험마다 모듈을 새로 읽는다(새 창을 흉내 낸다).
// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Scene } from "../src/lib/scenes";
import type { SceneGenDataApi } from "../src/lib/useSceneGenData";

// 시험마다 SceneBoard 를 새로 읽는다(위) — 단독 2.7초인 첫 시험이 전체 실행(파일 병렬)에서 기본 5초를 넘었다(seedanceRenderHarness 와 같은 까닭·같은 값)
vi.setConfig({ testTimeout: 20_000 });

const fixture = vi.hoisted(() => ({ data: null as unknown as SceneGenDataApi }));
vi.mock("../src/lib/useSceneGenData", () => ({ useSceneGenData: () => fixture.data }));

const noop = () => {};
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.resetModules();
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
  window.name = "";
  vi.unstubAllGlobals();
});

const scene = (id = "A"): Scene => ({
  id, name: id, created_at: 0, edges: [],
  cards: [
    { id: "gen1", kind: "generation", x: 0, y: 0 },
    { id: "t1", kind: "text", x: 400, y: 0, text: "t1" },
  ],
}) as unknown as Scene;
const leave = (selection: object) => localStorage.setItem("mvhub.canvasHandoff", JSON.stringify({
  promptVisible: true, batchCount: 1, prompt: null, selection, at: Date.now(),
}));
const selectedIds = () => [...host.querySelectorAll<HTMLElement>(".scene-card.sel")].map((el) => el.dataset.id);

async function open(sceneValue: Scene) {
  const { SceneBoard } = await import("../src/components/scene/SceneBoard");
  const onBindingChange = vi.fn();
  const actionRef = { current: null as { selection: () => unknown } | null };
  const show = (value: Scene) => act(async () => {
    root.render(<SceneBoard scene={value} onChange={noop} onBindingChange={onBindingChange} actionRef={actionRef as never} />);
  });
  await show(sceneValue);
  return { onBindingChange, actionRef, show };
}

it("캔버스 창은 넘긴 생성 카드를 고른 채로 시작하고 프롬프트 창도 그 카드에 이어진다 · 없는 카드는 뺀다", async () => {
  window.name = "contenthub-canvas";
  leave({ sceneId: "A", cardIds: ["gen1", "gone"], groupIds: [] });
  const { onBindingChange, actionRef } = await open(scene());
  expect(selectedIds()).toEqual(["gen1"]);
  expect(onBindingChange).toHaveBeenLastCalledWith(expect.objectContaining({ sceneId: "A", cardId: "gen1" }));
  expect(actionRef.current?.selection()).toEqual({ sceneId: "A", cardIds: ["gen1"], groupIds: [] }); // 메인 창이 넘길 때 읽는 손잡이
});

it("다시 그려도(다른 탭에 갔다 옴) 넘긴 선택을 다시 입히지 않는다", async () => {
  window.name = "contenthub-canvas";
  leave({ sceneId: "A", cardIds: ["t1"], groupIds: [] });
  await open(scene());
  expect(selectedIds()).toEqual(["t1"]);
  act(() => root.unmount()); // 캔버스 탭을 떠났다
  root = createRoot(host);
  await open(scene());
  expect(selectedIds()).toEqual([]);
});

it("다른 씬의 선택은 입히지 않는다 · 메인 창은 넘긴 선택을 쓰지 않는다", async () => {
  window.name = "contenthub-canvas";
  leave({ sceneId: "B", cardIds: ["gen1"], groupIds: [] });
  await open(scene("A"));
  expect(selectedIds()).toEqual([]);

  act(() => root.unmount());
  root = createRoot(host);
  vi.resetModules();
  window.name = "";
  leave({ sceneId: "A", cardIds: ["gen1"], groupIds: [] });
  const { onBindingChange } = await open(scene("A"));
  expect(selectedIds()).toEqual([]);
  expect(onBindingChange).not.toHaveBeenCalledWith(expect.objectContaining({ cardId: "gen1" }));
});
