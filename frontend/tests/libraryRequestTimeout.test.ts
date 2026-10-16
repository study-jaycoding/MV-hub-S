// Jay 결정 15A(10-15): 목록·위치 확인 요청에 30초 제한 + 실제 취소. 허브가 멎으면 목록 줄이 끝없이 '불러오는 중'에 막혔다.
//  fetch 까지 넘어간 signal 이 실제로 aborted 가 되는지, 다른 실패는 그대로인지 본다(Codex 2차 의견).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, GEN_PAGE } from "../src/api";
import { LIBRARY_LIST_TIMEOUT_MESSAGE, LIBRARY_LIST_TIMEOUT_MS, timedLibraryRequest } from "../src/lib/libraryRequestTimeout";
import { fetchAllGenerations } from "../src/lib/fetchAllGenerations";

let seen: RequestInit | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  seen = undefined;
  // 답이 오지 않는 허브 — signal 이 끊기면 그때 실패한다(브라우저 fetch 와 같다)
  vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => {
    seen = init;
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
  }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("목록 요청 30초 제한", () => {
  it.each([
    ["목록", (signal: AbortSignal) => api.listGenerations({ tab: "my" } as never, null, GEN_PAGE, { signal })],
    ["휴지통", (signal: AbortSignal) => api.listTrash("", 0, GEN_PAGE, signal)],
    ["위치 확인", (signal: AbortSignal) => api.locateGenerations({ tab: "my", gen_ids: ["g"] } as never, signal)],
  ])("%s — 30초가 지나면 fetch 의 signal 이 끊기고 그 뜻의 글로 실패한다", async (_name, run) => {
    const result = timedLibraryRequest(run);
    const settled = result.catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(LIBRARY_LIST_TIMEOUT_MS - 1);
    expect(seen?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(seen?.signal?.aborted).toBe(true);
    await expect(settled).resolves.toBe(LIBRARY_LIST_TIMEOUT_MESSAGE);
  });

  // 81회차 F-B-03: 끝까지 받기는 signal·제한 없이 쪽을 받아, 멈춘 요청이 폴더 카드의 한 줄 대기열을 끝없이 막았다 — 쪽마다 30초 + 실제 취소.
  it.each([["답(머리)이 안 옴", false], ["본문이 멈춤", true]])("끝까지 받기(fetchAllGenerations) — %s: 30초 뒤 그 쪽의 fetch signal 이 끊기고 그 뜻의 글로 실패한다", async (_name, headersArrive) => {
    if (headersArrive) {
      vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => {
        seen = init;
        return Promise.resolve({
          ok: true, status: 200, headers: new Headers(),
          json: () => new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          }),
        });
      }));
    }
    const settled = fetchAllGenerations({ tab: "my" } as never, () => true, { leanPrompt: true }).catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(LIBRARY_LIST_TIMEOUT_MS - 1);
    expect(seen?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(seen?.signal?.aborted).toBe(true);
    await expect(settled).resolves.toBe(LIBRARY_LIST_TIMEOUT_MESSAGE);
  });

  it("제한 안에 온 실패는 그대로 던지고, 타이머를 남기지 않는다", async () => {
    const boom = new Error("500: boom");
    await expect(timedLibraryRequest(() => Promise.reject(boom))).rejects.toBe(boom);
    expect(vi.getTimerCount()).toBe(0);
  });
});
