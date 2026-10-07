// 씬에 적힌 id 가 "toString"·"constructor" 같은 이름이어도 캔버스가 죽지 않는다 — 실제 SceneBoard 로 본다.
//
// 화면은 id 로 사전(일반 객체)을 조회한다. `map["toString"]` 은 Object.prototype 의 함수를 돌려줘서, 그것을
// 생성물로 믿은 카드가 `generation.assets[0]` 에서 죽었다. 그런 씬이 저장소에 있으면 다시 켜도 죽는다
// (Codex 코드 리뷰 2026-10-07). 가져오기 검증만으로는 못 막는다 — 옛 저장소 이관·기존 저장소·DB 백업 복구는
// 그 관문을 지나지 않는다. 그래서 조회하는 쪽(ownEntry)에서 막고, 가져오기 검증은 보조로 둔다.
// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SceneBoard } from "../src/components/scene/SceneBoard";
import { ownEntry } from "../src/lib/ownEntry";
import { SCENE_EXPORT_FORMAT, SCENE_EXPORT_VERSION, parseSceneImport, type Scene } from "../src/lib/scenes";
import type { SceneGenDataApi } from "../src/lib/useSceneGenData";

const fixture = vi.hoisted(() => ({ data: null as unknown as SceneGenDataApi }));
vi.mock("../src/lib/useSceneGenData", () => ({ useSceneGenData: () => fixture.data }));

const noop = () => {};
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
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
  vi.unstubAllGlobals();
});

it("자기 속성만 돌려준다 — 물려받은 이름은 없는 것으로 친다", () => {
  const map: Record<string, number> = { real: 1 };
  expect(ownEntry(map, "real")).toBe(1);
  for (const id of ["toString", "constructor", "__proto__", "hasOwnProperty", "valueOf"]) {
    expect(ownEntry(map, id)).toBeUndefined();
  }
  expect(ownEntry(map, null)).toBeUndefined();
  expect(ownEntry(map, undefined)).toBeUndefined();
});

// 이미 저장소에 들어와 있는 씬(가져오기 검증을 지나지 않은 것)을 그대로 연다.
it("id 가 Object.prototype 의 이름인 카드가 든 씬을 열어도 캔버스가 뜬다", async () => {
  const cards = [
    { id: "gen", kind: "generation", x: 0, y: 0, genId: "toString", genIds: ["toString", "constructor", "valueOf"] },
    // ComfyCard 는 대표 결과를 genData 에서 찾아 그린다 — 여기가 처음 보고된 자리다.
    { id: "comfy", kind: "comfy", x: 300, y: 0, genId: "toString", comfyCfg: { content: "{}", status: "done" } },
    { id: "list", kind: "list", x: 600, y: 0 },
    { id: "render", kind: "render", x: 900, y: 0 },
    { id: "text", kind: "text", x: 0, y: 300, text: "글" },
  ];
  const edges = [
    { id: "e1", from: "gen", to: "list" },
    { id: "e2", from: "gen", to: "render" },
    { id: "e3", from: "gen", to: "text" },
    { id: "e4", from: "gen", to: "comfy" },
  ];
  const scene = { id: "s", name: "s", created_at: 0, cards, edges } as unknown as Scene;
  await act(async () => {
    root.render(<SceneBoard scene={scene} onChange={noop} />);
  });
  expect(host.querySelectorAll(".scene-card")).toHaveLength(cards.length);
});

it("가져오기는 그런 id 를 받지 않는다(보조 방어) — 필드는 지우고, 카드 id 면 파일을 거절한다", () => {
  const file = (cards: object[], edges: object[] = []) =>
    JSON.stringify({ format: SCENE_EXPORT_FORMAT, version: SCENE_EXPORT_VERSION, scene: { name: "x", cards, edges } });
  const snap = parseSceneImport(
    file(
      [
        {
          id: "c1",
          kind: "generation",
          x: 0,
          y: 0,
          genId: "toString",
          genIds: ["g1", "constructor", "__proto__"],
          refs: [{ file_path: "asset:P|a.png", type: "image", source_gen_id: "valueOf" }],
          pendingGenerationAttempts: [{ attemptId: "a", generationId: "hasOwnProperty", createdAt: 1 }],
        },
      ],
      [{ id: "e1", from: "c1", to: "toString" }, { id: "e2", from: "c1", to: "c1" }],
    ),
  );
  expect(snap.cards[0]).toEqual({
    id: "c1",
    kind: "generation",
    x: 0,
    y: 0,
    genIds: ["g1"],
    refs: [{ file_path: "asset:P|a.png", type: "image" }],
    pendingGenerationAttempts: [],
  });
  expect(snap.edges).toEqual([{ id: "e2", from: "c1", to: "c1" }]);
  expect(() => parseSceneImport(file([{ id: "constructor", kind: "text", x: 0, y: 0 }]))).toThrow(/알 수 없는 카드/);
});
