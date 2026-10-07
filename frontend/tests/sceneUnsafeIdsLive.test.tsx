// 서버 응답을 거쳐도 "toString" 같은 id 가 캔버스를 죽이지 않는다 — **실제 훅**(useSceneGenData)으로 본다.
//
// sceneUnsafeIds.test.tsx 는 생성물 훅을 가짜로 두고 조회하는 쪽만 봤다. 그런데 훅 안에서 서버 응답 사전을
// `batch.items[id]` 로 읽으면, 응답이 `{ items: {}, missing: ["toString"] }` 여도 상속 함수가 나와 캐시에
// **자기 속성으로** 들어간다 — 그 뒤로는 자기 속성만 보는 조회도 통과시킨다(Codex 코드 리뷰 P1).
// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SceneBoard } from "../src/components/scene/SceneBoard";
import { hydrateGen } from "../src/lib/sceneGenDataStore";
import type { Scene } from "../src/lib/scenes";

const UNSAFE = ["toString", "constructor", "valueOf"];
let host: HTMLDivElement;
let root: Root;
let batchCalls: string[][];

const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
const scene = {
  id: "s",
  name: "s",
  created_at: 0,
  edges: [],
  cards: [
    { id: "gen", kind: "generation", x: 0, y: 0, genId: "toString", genIds: UNSAFE },
    { id: "comfy", kind: "comfy", x: 300, y: 0, genId: "toString", comfyCfg: { content: "{}", status: "done" } },
  ],
} as unknown as Scene;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("BroadcastChannel", undefined);
  vi.stubGlobal("WebSocket", class { constructor() { throw new Error("Unexpected socket in isolated UI test"); } });
  localStorage.clear();
  sessionStorage.clear();
  batchCalls = [];
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
    if (url === "/api/generations/batch") {
      const ids = (JSON.parse(String(init?.body)) as { gen_ids: string[] }).gen_ids;
      batchCalls.push(ids);
      // 서버는 그런 생성물을 모른다 — 빈 사전과 '없음' 목록을 준다.
      return Promise.resolve(response({ items: {}, materials: {}, missing: ids }));
    }
    if (url.startsWith("/api/generation-views?")) return Promise.resolve(response({ card: {}, last_card_id: null }));
    if (url.startsWith("/api/models")) return Promise.resolve(response([]));
    return Promise.reject(new Error(`Unexpected HTTP in isolated UI test: ${url}`));
  }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const settle = () =>
  act(async () => {
    for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });

it("서버가 '없음'으로 답한 뒤에도, 다시 열어도 캔버스가 뜬다 — 상속 함수가 생성물 캐시에 들어가지 않는다", async () => {
  await act(async () => {
    root.render(<SceneBoard scene={scene} onChange={() => {}} />);
  });
  await settle();
  expect(batchCalls.length).toBeGreaterThan(0); // 실제 훅이 서버에 물었다
  expect(batchCalls[0]).toEqual(expect.arrayContaining(UNSAFE));
  expect(host.querySelectorAll(".scene-card")).toHaveLength(2);
  expect(hydrateGen(UNSAFE)).toEqual({}); // 캐시에 아무것도 들어가지 않았다

  // 탭을 나갔다 돌아온다(캔버스가 다시 마운트되며 캐시에서 되살린다).
  act(() => root.unmount());
  root = createRoot(host);
  await act(async () => {
    root.render(<SceneBoard scene={scene} onChange={() => {}} />);
  });
  await settle();
  expect(host.querySelectorAll(".scene-card")).toHaveLength(2);
});
