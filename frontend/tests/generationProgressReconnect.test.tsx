// @vitest-environment jsdom
// 53회차(Codex 검토) — 실시간 연결(/ws)이 끊겼다 다시 붙으면, 출처 없는 synced 와 같은 전체 보정을 한다. 전엔 목록 reload 만 해서
//  캔버스의 완료 카드·사이드바(libraryChanged)와 열린 히스토리·코멘트가 끊긴 동안의 변경을 못 따라잡았다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Generation } from "../src/types";

const mocks = vi.hoisted(() => ({ onReconnect: null as null | (() => void), dispatch: vi.fn(), reload: vi.fn(), bumpBoard: vi.fn(), tick: vi.fn() }));
vi.mock("../src/api", () => ({ api: { getGeneration: vi.fn() },
  connectProgress: (_listener: unknown, onReconnect?: () => void) => { mocks.onReconnect = onReconnect ?? null; return () => {}; },
}));
vi.mock("../src/lib/sceneRecentDoneStore", () => ({ isKnownGen: () => true, observeStatus: vi.fn() }));
vi.mock("../src/lib/assetBroadcast", () => ({ postAssetsUpdated: vi.fn() }));
vi.mock("../src/lib/appEvents", () => ({ APP_EVENTS: { libraryChanged: "ch:library-changed" }, dispatchAppEvent: mocks.dispatch }));

import { useGenerationProgress } from "../src/lib/useGenerationProgress";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  for (const fn of [mocks.dispatch, mocks.reload, mocks.bumpBoard, mocks.tick]) fn.mockReset();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

function Probe() {
  useGenerationProgress({ enabled: true, scopeKey: "s", gens: [] as Generation[], setGens: () => {}, reload: mocks.reload,
    bumpBoard: mocks.bumpBoard, setSyncTick: mocks.tick, historyBoardVisible: true, commentsVisible: true });
  return null;
}

it("다시 붙으면 목록·캔버스(libraryChanged)·열린 히스토리·코멘트를 함께 깨운다", async () => {
  act(() => root.render(<Probe />));
  expect(mocks.onReconnect).not.toBeNull();
  act(() => mocks.onReconnect!());
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); }); // 보정은 synced 처럼 잠깐 모아서 한 번
  expect(mocks.reload).toHaveBeenCalledWith(true);
  expect(mocks.dispatch).toHaveBeenCalledWith("ch:library-changed"); // 전엔 없었다 — 캔버스의 완료 카드가 깨지 않았다
  expect(mocks.bumpBoard).toHaveBeenCalled(); // 열린 히스토리
  expect(mocks.tick).toHaveBeenCalled(); // 열린 코멘트
});
