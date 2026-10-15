// @vitest-environment jsdom
// Codex 62회차(4B × 색 단축키) — 다른 탭 로그아웃으로 멈춘 동안 R/G/B 는 화면 색만 바꾸고, 저장과 되돌리기 조회가 둘 다 막혀
//  "서버 상태로 되돌렸습니다"라는 틀린 안내가 떴다. 멈춘 동안은 칠하지 않고 멈춤만 알린다.
import { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("../src/api", () => ({ api: { setColorsBatch: vi.fn() } }));

import { api } from "../src/api";
import { API_PAUSED_MESSAGE, setApiPause } from "../src/lib/http";
import { useGenerationKeyboardActions } from "../src/lib/useGenerationKeyboardActions";
import type { Filters, Generation } from "../src/types";

it("멈춘 동안 색 키는 칠하지도 저장하지도 않고 멈춤을 알린다 — 풀리면 다시 칠한다", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(api.setColorsBatch).mockResolvedValue({ failed: [] } as never);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const flash = vi.fn();
  const setGens = vi.fn();
  const gens = [{ id: "g1", color: null }] as unknown as Generation[];
  function Host() {
    useGenerationKeyboardActions({
      clearSelect: () => {}, filtersRef: useRef({ tab: "my" } as Filters), flash, gensRef: useRef(gens),
      reload: async () => {}, selectedRef: useRef(new Set(["g1"])), setGens,
    });
    return null;
  }
  const pressR = () => act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "r" })); });
  try {
    act(() => root.render(<Host />));
    setApiPause("shared");
    pressR();
    await act(async () => {});
    expect(flash).toHaveBeenCalledWith(API_PAUSED_MESSAGE);
    expect(setGens).not.toHaveBeenCalled();
    expect(api.setColorsBatch).not.toHaveBeenCalled();

    setApiPause(null);
    pressR();
    await act(async () => {});
    expect(setGens).toHaveBeenCalled();
    expect(api.setColorsBatch).toHaveBeenCalledTimes(1);
  } finally {
    setApiPause(null);
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
