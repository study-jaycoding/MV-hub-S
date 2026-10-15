// @vitest-environment jsdom
// 70회차 격리 실측 — 캔버스에서 다른 씬을 열면 완료된 카드가 생성물 정보를 받기 전(약 78ms) '생성 중' 로고로 비쳤다. 한 번 본 씬도 캐시 복원이
//  그린 뒤라 같았다. → 캐시 복원은 그리기 전에, 아직 답을 못 받은 카드는 로고 대신 빈 바탕(실제 SceneBoard + 실제 useSceneGenData).
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Generation } from "../src/types";
import type { Scene } from "../src/lib/scenes";

let root: Root | null;
let host: HTMLDivElement;
let cache: typeof import("../src/lib/sceneGenDataStore");
let Board: typeof import("../src/components/scene/SceneBoard").SceneBoard;
let polls: ReturnType<typeof deferred<Response>>[];
function generation(id: string): Generation {
  return { id, color: "#777777", status: "done", prompt: "synthetic", is_mine: true,
    worker_id: "worker", worker_name: null, display_prompt: null, model: null, params: {}, error: null,
    created_at: "2026-09-17", tags: [], auto_tags: [], assets: [], references: [], shared: false,
    parent_gen_id: null, is_source: false, source_name: null, comment: null, comment_count: 0,
    has_unread: false, local_only: false, creator_uid: null, creator_name: null,
    workspace_scope: "personal", workspace_id: null, workspace_name: null, project_id: null, deleted: false };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const sceneWith = (id: string, genId: string): Scene =>
  ({ id, name: id, created_at: 0, edges: [], cards: [{ id: `card-${genId}`, kind: "generation", genId, x: 0, y: 0 }] });
const board = (scene: Scene) => <Board scene={scene} onChange={() => {}} authKey="account-A" authReady />;
const logo = () => host.querySelector(".scene-genloading-logo");
const content = () => host.querySelector(".linb-colorbar"); // 완료 카드(HistoryBoardNode)가 그려졌다

beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("BroadcastChannel", undefined);
  vi.stubGlobal("WebSocket", class { constructor() { throw new Error("Real socket forbidden"); } });
  localStorage.clear(); sessionStorage.clear();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  const apiModule = await import("../src/api");
  cache = await import("../src/lib/sceneGenDataStore");
  const scopeModule = await import("../src/lib/accountScope");
  Board = (await import("../src/components/scene/SceneBoard")).SceneBoard;
  apiModule.setAuthToken("synthetic-A"); scopeModule.setAccountScope("synthetic-A");
  polls = [];
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    if (url === "/api/generations/batch") { const reply = deferred<Response>(); polls.push(reply); return reply.promise; }
    if (url.startsWith("/api/generation-views?")) return Promise.resolve(response({ card: {}, last_card_id: null }));
    if (url.startsWith("/api/models")) return Promise.resolve(response([]));
    throw new Error(`Unexpected request ${url}`);
  }));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
}, 30_000); // SceneBoard 전체를 처음 불러온다(sceneShareRefresh 와 같은 이유)
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null; host.remove(); await vi.advanceTimersByTimeAsync(0);
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it("a card whose generation has not answered yet is a blank body, not the 'generating' logo — then the finished card", async () => {
  await act(async () => root!.render(board(sceneWith("scene-B", "b"))));
  expect(polls).toHaveLength(1); // 조회는 떠 있고 아직 답이 없다
  expect([logo(), content()]).toEqual([null, null]);
  await act(async () => polls[0].resolve(response({ items: { b: generation("b") }, materials: { b: [] }, missing: [] })));
  expect([logo(), content() !== null]).toEqual([null, true]);
});

// Codex 리뷰 P2 — 제출 성공으로 표식이 지워진 뒤 첫 조회 응답 전에도 '생성 중' 로고다(빈 바탕으로 바뀌지 않는다) · 첫 조회가 실패해 다시 묻는 동안도
it("a card whose submission marker was just cleared keeps the 'generating' logo until the first answer, and so does a failed first poll", async () => {
  const attempt = { attemptId: "t1", generationId: "c", createdAt: 0 };
  const withAttempt: Scene = { ...sceneWith("scene-C", "c"), cards: [{ id: "card-c", kind: "generation", genId: "c", x: 0, y: 0, pendingGenerationAttempts: [attempt] }] };
  await act(async () => root!.render(board(withAttempt)));
  expect(logo()).not.toBeNull();
  await act(async () => root!.render(board(sceneWith("scene-C", "c")))); // 제출 성공 — 표식이 지워졌다, 조회 응답은 아직
  expect(logo()).not.toBeNull();
  // 처음 보는 카드의 첫 조회가 실패하면(다시 묻는 동안) 전처럼 '생성 중'
  await act(async () => root!.render(board(sceneWith("scene-D", "d"))));
  expect(logo()).toBeNull();
  await act(async () => polls[polls.length - 1].resolve(new Response("{}", { status: 500 })));
  expect(logo()).not.toBeNull();
});

it("switching to a scene seen before: the leaving scene is not painted in the gap, then its finished cards appear without the logo", async () => {
  cache.putGen(generation("a")); // 앞서 본 씬의 카드
  await act(async () => root!.render(board(sceneWith("scene-B", "b"))));
  const board_ = () => host.querySelector(".scene-board")!;
  let logoSeen = false;
  const watch = new MutationObserver(() => { if (logo()) logoSeen = true; });
  watch.observe(host, { childList: true, subtree: true });
  // 클릭처럼 동기 우선순위로 씬을 바꾼다 — 그 커밋이 끝난 자리는 '틈'(카드는 아직 떠난 씬의 것)이다: 칠하지 않는다
  flushSync(() => root!.render(board(sceneWith("scene-A", "a"))));
  expect(board_().hasAttribute("data-switching")).toBe(true);
  await act(async () => {});
  watch.disconnect();
  expect([board_().hasAttribute("data-switching"), content() !== null, logoSeen]).toEqual([false, true, false]);
});

// 73회차 — 틈에 떠난 씬의 카드가 새 카메라로 놓여 화면 밖 lazy 그림을 깨웠다(큰 씬 12~40장). 틈에는 캔버스 아래를 건너뛴다(scene.css).
it("the gap skips the canvas subtree so the leaving scene's lazy images are not woken", () => {
  const css = readFileSync(new NodeURL("../src/styles/scene.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .find(([, selector]) => selector.trim() === ".scene-board[data-switching] .scene-canvas");
  expect(rule?.[2]).toMatch(/content-visibility:\s*hidden/);
});
