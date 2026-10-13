// @vitest-environment jsdom
// 28회차 ③(Codex 코드 리뷰 P2): 워크플로를 읽는 중(JSON 놓기·↻ 의 응답 전)의 실행은 **교체 전 워크플로**로 나간다. 카드의 실행 단추는 잠기지만 본문
//  결과물의 '재생성'·연결된 렌더 카드도 실행을 부른다 → 입구(실행 훅)에서 한 번 막는다. 응답을 시험이 쥐는 단위 시험(12회차 요령).
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { APP_EVENTS } from "../src/lib/appEvents";
import type { SceneCard, SceneEdge } from "../src/lib/scenes";
import type { Generation } from "../src/types";

const mocks = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../src/lib/comfyApi", async (orig) => {
  const actual = await orig<typeof import("../src/lib/comfyApi")>();
  return { ...actual, comfyApi: { ...actual.comfyApi, run: mocks.run } };
});

import { useSceneComfyExecution, WORKFLOW_LOADING_MESSAGE } from "../src/lib/useSceneComfyExecution";

let host: HTMLDivElement;
let root: Root;
let flashes: string[];
const onFlash = (event: Event) => { flashes.push((event as CustomEvent<string>).detail); };
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  flashes = [];
  window.addEventListener(APP_EVENTS.flash, onFlash);
  mocks.run.mockReset().mockResolvedValue({ outputs: [{ kind: "image", url: "/out.png" }], prompt_id: "p1" });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount()); host.remove();
  window.removeEventListener(APP_EVENTS.flash, onFlash);
  vi.unstubAllGlobals();
});

const comfy = (id: string): SceneCard => ({
  id, kind: "comfy", x: 0, y: 0,
  comfyCfg: { name: "wf", content: '{"wf":1}', nodeCount: 1, params: [], paramValues: {}, paramExposed: [], outputs: [], output: null, status: "idle", error: null },
} as unknown as SceneCard);

function mount(cards: SceneCard[], edges: SceneEdge[], loading: () => boolean) {
  let api!: ReturnType<typeof useSceneComfyExecution>;
  const onRenderCards = vi.fn(async () => {});
  function Host() {
    const sceneIdRef = useRef("s");
    const cardsRef = useRef(cards);
    const edgesRef = useRef(edges);
    const genDataRef = useRef<Record<string, Generation>>({});
    api = useSceneComfyExecution({
      sceneIdRef, cardsRef, edgesRef, genDataRef, refParents: {},
      setCards: (next) => { cardsRef.current = typeof next === "function" ? next(cardsRef.current) : next; },
      flushPending: () => {}, patchComfyCfg: () => {}, saveComfyToLibrary: async () => ({ saved: 0, failed: 0 }),
      onRenderCards, isWorkflowLoading: loading,
    });
    return null;
  }
  act(() => root.render(<Host />));
  return { api: () => api, onRenderCards };
}
const settle = () => act(async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); });

it("워크플로를 읽는 중인 카드의 실행(카드 단추·본문 재생성이 부르는 runComfy)은 입구에서 막는다 — 요청 0·안내 1. 읽기가 끝나면 나간다", async () => {
  let loading = true;
  const board = mount([comfy("c")], [], () => loading);
  let result: boolean | undefined;
  await act(async () => { result = await board.api().runComfy("c"); });
  expect(result).toBe(false);
  expect(mocks.run).not.toHaveBeenCalled();
  expect(flashes).toEqual([WORKFLOW_LOADING_MESSAGE]);
  loading = false;
  await act(async () => { await board.api().runComfy("c"); });
  await settle();
  expect(mocks.run).toHaveBeenCalledTimes(1); // 같은 고정물로 실행이 실제로 나간다 — 위의 0 이 고정물 탓이 아니다
});

it("연결된 렌더 카드의 실행(배치 — runPlanComfyCopies)도 읽는 중인 Comfy 카드가 하나라도 있으면 시작하지 않는다", async () => {
  let loading = true;
  // comfy → generation → render(생성 카드를 체크한 채) — 렌더 계획에 comfy 가 든다
  const cards: SceneCard[] = [
    comfy("c"),
    { id: "g", kind: "generation", x: 300, y: 0 } as unknown as SceneCard,
    { id: "r", kind: "render", x: 600, y: 0, unchecked: [] } as unknown as SceneCard,
  ];
  const edges: SceneEdge[] = [{ from: "c", to: "g" }, { from: "g", to: "r" }] as unknown as SceneEdge[];
  const board = mount(cards, edges, (id) => loading && id === "c");
  await act(async () => { await board.api().orchestrateRender("r"); });
  await settle();
  expect(mocks.run).not.toHaveBeenCalled();
  expect(board.onRenderCards).not.toHaveBeenCalled();
  expect(flashes).toEqual([WORKFLOW_LOADING_MESSAGE]);
  loading = false;
  await act(async () => { await board.api().orchestrateRender("r"); });
  await settle();
  expect(mocks.run).toHaveBeenCalledTimes(1); // 읽기가 끝나면 같은 계획이 실행된다 — 위의 0 이 계획이 빈 탓이 아니다
});
