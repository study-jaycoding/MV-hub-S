// @vitest-environment jsdom
// 손상된 카드 묶음(2026-11-11 실제 씬 '뻘뻘뻘_프롤로그_part2' — groups 에 연결선 357개)이 섞여도 캔버스가 멈추지 않고 열린다.
//  묶음 모양이 아닌 항목(cardIds 가 배열이 아님)만 버리고 멀쩡한 묶음은 그대로 그린다(sceneDerive.liveSceneGroups).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SceneBoard } from "../src/components/scene/SceneBoard";
import type { Scene } from "../src/lib/scenes";
import type { SceneGenDataApi } from "../src/lib/useSceneGenData";

const fixture = vi.hoisted(() => ({ data: null as unknown as SceneGenDataApi }));
vi.mock("../src/lib/useSceneGenData", () => ({ useSceneGenData: () => fixture.data }));

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("BroadcastChannel", undefined);
  vi.stubGlobal("WebSocket", class { constructor() { throw new Error("Unexpected socket in isolated UI test"); } });
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("Unexpected network in isolated UI test"))));
  localStorage.clear(); sessionStorage.clear();
  const data = {};
  fixture.data = { genData: data, genDataRef: { current: data }, setGenData: () => {}, missingIds: new Set(), disabledIds: new Set(), refParents: {} } as unknown as SceneGenDataApi;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("groups 에 연결선 모양 항목이 섞인 씬도 열리고, 멀쩡한 묶음은 그대로 그린다", async () => {
  const scene = {
    id: "broken", name: "S", created_at: 0,
    cards: [{ id: "c1", kind: "text", text: "a", x: 100, y: 100 }, { id: "c2", kind: "text", text: "b", x: 400, y: 100 }],
    edges: [{ id: "e1", from: "c1", to: "c2" }],
    groups: [
      { id: "g1", name: "살아 있는 묶음", cardIds: ["c1"] },
      { id: "e1", from: "c1", to: "c2", order: 1 }, // 연결선이 묶음 칸에 들어간 손상 항목
    ],
  } as unknown as Scene;
  await act(async () => { root.render(<SceneBoard scene={scene} onChange={() => undefined as never} />); });
  expect(host.querySelector('.scene-card[data-id="c1"]')).not.toBeNull();
  expect([...host.querySelectorAll(".scene-group-name")].map((el) => el.textContent)).toEqual(["살아 있는 묶음"]);
});
