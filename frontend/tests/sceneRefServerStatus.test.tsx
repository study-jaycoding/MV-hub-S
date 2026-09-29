// 서버에 없는 레퍼런스(Jay 2026-09-29) — 서버 판정 → 가게 → 실제 SceneBoard·ReferenceCard 까지 한 번에 본다.
// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SceneBoard } from "../src/components/scene/SceneBoard";
import { relinkSceneAssetRefs } from "../src/lib/sceneAssetRelink";
import { saveScenes, type Scene, type SceneRef } from "../src/lib/scenes";
import type { SceneGenDataApi } from "../src/lib/useSceneGenData";

// 바꾸는 것은 생성물 읽기와 자동 매칭 응답뿐 — SceneBoard·ReferenceCard·판정 가게는 실제 코드다.
const fixture = vi.hoisted(() => ({
  data: null as unknown as SceneGenDataApi,
  locate: vi.fn(),
  upload: vi.fn(),
}));
vi.mock("../src/lib/useSceneGenData", () => ({ useSceneGenData: () => fixture.data }));
vi.mock("../src/api", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/api")>();
  return {
    ...mod,
    api: {
      ...mod.api,
      locateAssets: (...args: unknown[]) => fixture.locate(...args),
      uploadReferenceFiles: (...args: unknown[]) => fixture.upload(...args),
    },
  };
});

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
  fixture.locate.mockReset();
  fixture.upload.mockReset();
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

const ref = (file_path: string, name: string): SceneRef => ({ file_path, type: "image", name });
const cardEl = (id: string) => host.querySelector<HTMLElement>(`[data-id="${id}"]`)!;
const refScene = (id: string, workspaceId: string, cards: { id: string; refs: SceneRef[] }[]): Scene =>
  ({
    id, name: "씬", created_at: 0, edges: [], workspace: { id: workspaceId, name: "가" },
    cards: cards.map((c, i) => ({ id: c.id, kind: "reference", x: i * 200, y: 0, refs: c.refs })),
  }) as unknown as Scene;

it("서버에 없는 참조는 빨간 테두리 + 안내, 이 PC 에만 있는 참조는 그림 + 오른쪽 위 마크", async () => {
  const scene = refScene("offserver", "ws-1", [
    { id: "missing", refs: [ref("asset:Q|CH/gone.png", "gone.png")] },
    { id: "local", refs: [ref("asset:imports|mine.png", "mine.png")] },
    { id: "ok", refs: [ref("asset:P|ok.png", "ok.png")] },
    { id: "multi", refs: [ref("asset:P|ok.png", "ok.png"), ref("asset:Q|two.png", "two.png")] },
  ]);
  saveScenes(null, [scene]);
  fixture.locate.mockResolvedValue({
    fixed: [],
    unresolved: [],
    missing: ["asset:Q|CH/gone.png", "asset:Q|two.png"],
    local: ["asset:imports|mine.png"],
  });
  await relinkSceneAssetRefs();
  await act(async () => {
    root.render(<SceneBoard scene={scene} onChange={noop} />);
  });

  // 받은 사람 — 빨간 테두리 + 붉은 빗금 + 이유와 파일 이름. 썸네일은 부르지 않는다.
  const missing = cardEl("missing");
  expect(missing.classList.contains("off-server")).toBe(true);
  expect(missing.querySelector(".scene-ref-offmsg")?.textContent).toBe("서버에 없음gone.png");
  expect(missing.querySelector(".scene-refthumb-ph.off-server")).not.toBeNull();
  expect(missing.querySelector("img, video")).toBeNull();

  // 가진 사람 — 그림은 그대로 + 오른쪽 위 마크
  const local = cardEl("local");
  expect(local.classList.contains("off-server")).toBe(true);
  expect(local.querySelector("img")).not.toBeNull();
  expect(local.querySelector(".scene-ref-offmark")?.getAttribute("title")).toContain("이 PC 에만");
  expect(local.querySelector(".scene-ref-offmsg")).toBeNull();

  // 서버에 있는 참조 — 아무 표시 없음
  const ok = cardEl("ok");
  expect(ok.classList.contains("off-server")).toBe(false);
  expect(ok.querySelector(".scene-ref-offmark, .scene-ref-offmsg")).toBeNull();

  // 여러 장 카드(옛 씬) — 없는 칸만 붉은 빗금 + 작은 아이콘(글씨 없음)
  const multi = cardEl("multi");
  expect(multi.classList.contains("off-server")).toBe(true);
  expect(multi.querySelectorAll(".scene-refthumb-ph.off-server")).toHaveLength(1);
  expect(multi.querySelector(".scene-ref-offmini")).not.toBeNull();
  expect(multi.querySelector(".scene-ref-offmsg")).toBeNull();
});

it("로컬 파일을 끌어다 놓으면 프로젝트를 고르지 않아도 이 PC 에 두고, 곧바로 '이 PC에만' + 자동 복구 요청", async () => {
  const scene = refScene("dropscene", "ws-drop", []);
  saveScenes(null, [scene]);
  fixture.upload.mockResolvedValue({
    saved: [{ project: "imports", path: "mine-drop.png", name: "mine-drop.png", type: "image", sha256: "s", bytes: 3 }],
    skipped: [],
  });
  const onLocalRefsAdded = vi.fn();
  await act(async () => {
    root.render(<SceneBoard scene={scene} onChange={noop} onLocalRefsAdded={onLocalRefsAdded} />);
  });

  const file = new File(["png"], "mine-drop.png", { type: "image/png" });
  const drop = new Event("drop", { bubbles: true, cancelable: true });
  Object.assign(drop, {
    clientX: 20,
    clientY: 20,
    shiftKey: false,
    dataTransfer: { files: [file], items: [], types: ["Files"], getData: () => "" },
  });
  await act(async () => {
    host.querySelector(".scene-board")!.dispatchEvent(drop);
  });

  expect(fixture.upload).toHaveBeenCalledWith([file]); // 프로젝트 없이 — 이 PC 설치 폴더로
  const card = host.querySelector<HTMLElement>(".scene-card-ref");
  expect(card?.classList.contains("off-server")).toBe(true);
  expect(card?.querySelector(".scene-ref-offmark")).not.toBeNull();
  expect(onLocalRefsAdded).toHaveBeenCalledTimes(1);
});

it("다른 공간으로 물어본 판정은 이 캔버스에 번지지 않는다", async () => {
  saveScenes(null, [refScene("asked", "ws-a", [{ id: "a", refs: [ref("asset:Q|elsewhere.png", "elsewhere.png")] }])]);
  fixture.locate.mockResolvedValue({ fixed: [], unresolved: [], missing: ["asset:Q|elsewhere.png"], local: [] });
  await relinkSceneAssetRefs();

  const other = refScene("other", "ws-b", [{ id: "b", refs: [ref("asset:Q|elsewhere.png", "elsewhere.png")] }]);
  await act(async () => {
    root.render(<SceneBoard scene={other} onChange={noop} />);
  });
  expect(cardEl("b").classList.contains("off-server")).toBe(false);
  expect(cardEl("b").querySelector(".scene-ref-offmsg")).toBeNull();
});

it("리스트도 같은 판정 — 첫 장이 서버에 없으면 붉은 빗금 + 아이콘, 이 PC 에만 있으면 오른쪽 위 마크, 테두리 빨강", async () => {
  const scene = {
    id: "listscene", name: "씬", created_at: 0, workspace: { id: "ws-l", name: "가" },
    cards: [
      { id: "lr-miss", kind: "reference", x: 0, y: 0, refs: [ref("asset:Q|list-gone.png", "list-gone.png")] },
      { id: "lr-local", kind: "reference", x: 0, y: 200, refs: [ref("asset:imports|list-mine.png", "list-mine.png")] },
      { id: "lr-ok", kind: "reference", x: 0, y: 400, refs: [ref("asset:P|list-ok.png", "list-ok.png")] },
      { id: "L", kind: "list", x: 300, y: 0 },
      { id: "L2", kind: "list", x: 600, y: 0 },
    ],
    edges: [
      { id: "e1", from: "lr-miss", to: "L" },
      { id: "e2", from: "lr-local", to: "L" },
      { id: "e3", from: "lr-ok", to: "L" },
      { id: "e4", from: "lr-ok", to: "L2" },
    ],
  } as unknown as Scene;
  saveScenes(null, [scene]);
  fixture.locate.mockResolvedValue({
    fixed: [],
    unresolved: [],
    missing: ["asset:Q|list-gone.png"],
    local: ["asset:imports|list-mine.png"],
  });
  await relinkSceneAssetRefs();
  await act(async () => {
    root.render(<SceneBoard scene={scene} onChange={noop} />);
  });

  expect(cardEl("L").classList.contains("off-server")).toBe(true);
  expect(cardEl("L2").classList.contains("off-server")).toBe(false); // 서버에 다 있는 리스트는 그대로
  const cells = [...cardEl("L").querySelectorAll<HTMLElement>(".scene-listthumb")];
  expect(cells).toHaveLength(3);
  const [miss, local, ok] = cells;
  expect(miss.querySelector(".scene-listthumb-ph.off-server")).not.toBeNull();
  expect(miss.querySelector(".scene-ref-offmini")).not.toBeNull();
  expect(miss.querySelector("img")).toBeNull();
  expect(local.querySelector("img")).not.toBeNull();
  expect(local.querySelector(".scene-ref-offmark")?.getAttribute("title")).toContain("이 PC 에만");
  expect(ok.querySelector("img")).not.toBeNull();
  expect(ok.querySelector(".scene-ref-offmark, .scene-ref-offmini")).toBeNull();
});
