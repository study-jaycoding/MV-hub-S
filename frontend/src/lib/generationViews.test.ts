// 코덱스 코드 리뷰가 짚은 두 역전을 고정한다.
//  · 기록(PUT)은 보낸 순서대로 하나씩 — 병렬이면 서버 채번이 뒤집혀 화면과 재조회가 어긋난다.
//  · 늦게 도착한 조회(GET) 응답이 그사이 성공한 기록을 덮으면 안 된다.
import { beforeEach, describe, expect, it, vi } from "vitest";

type Pending = { url: string; method: string; resolve: (v: unknown) => void };
const net = vi.hoisted(() => ({ calls: [] as Pending[] }));

vi.mock("./http", () => ({
  jsonFetch: (url: string, init?: RequestInit) =>
    new Promise((resolve) => {
      net.calls.push({ url, method: init?.method || "GET", resolve });
    }),
  jsonBody: (v: unknown) => JSON.stringify(v),
}));

import {
  _resetGenerationViewsForTest,
  getGenerationViews,
  recordGenerationView,
  refreshGenerationViews,
} from "./generationViews";

const flush = () => new Promise((r) => setTimeout(r, 0));
const pending = (method: string) => net.calls.filter((c) => c.method === method);

beforeEach(() => {
  net.calls.length = 0;
  _resetGenerationViewsForTest();
});

describe("generationViews", () => {
  it("기록은 보낸 순서대로 하나씩 보낸다 — 앞 응답이 와야 뒤가 나간다", async () => {
    void recordGenerationView("gA", { sceneId: "s", cardId: "cA" });
    void recordGenerationView("gB", { sceneId: "s", cardId: "cB" });
    await flush();
    expect(pending("PUT")).toHaveLength(1); // B 는 아직 안 나갔다

    pending("PUT")[0].resolve({ recorded: true });
    await flush();
    expect(pending("PUT")).toHaveLength(2);
    expect(getGenerationViews("s").lastCardId).toBe("cA");

    pending("PUT")[1].resolve({ recorded: true });
    await flush();
    expect(getGenerationViews("s")).toEqual({ card: { cA: "gA", cB: "gB" }, lastCardId: "cB" });
  });

  it("늦게 온 조회 응답이 그사이 성공한 기록을 덮지 않고, 한 번 더 읽는다", async () => {
    void refreshGenerationViews("s"); // 옛 상태를 읽기 시작(응답은 아직)
    await flush();
    expect(pending("GET")).toHaveLength(1);

    void recordGenerationView("gB", { sceneId: "s", cardId: "cB" });
    await flush();
    pending("PUT")[0].resolve({ recorded: true });
    await flush();
    expect(getGenerationViews("s").lastCardId).toBe("cB");

    // 옛 조회 응답이 뒤늦게 도착 — A 가 마지막이라고 말한다
    pending("GET")[0].resolve({ card: { cA: "gA" }, last_card_id: "cA" });
    await flush();
    expect(getGenerationViews("s").lastCardId).toBe("cB"); // 덮이지 않았다
    expect(pending("GET")).toHaveLength(2); // 최신 상태를 다시 읽으러 갔다
  });

  it("서버가 거절한 팀 항목(recorded=false)은 store 를 건드리지 않는다", async () => {
    void recordGenerationView("remote-uuid", { sceneId: "s", cardId: "c" });
    await flush();
    pending("PUT")[0].resolve({ recorded: false });
    await flush();
    expect(getGenerationViews("s")).toEqual({ card: {}, lastCardId: null });
  });

  it("씬·카드 중 한쪽만 있으면 보내지 않는다", async () => {
    await recordGenerationView("g", { sceneId: "s", cardId: "" });
    expect(net.calls).toHaveLength(0);
  });

  it("앞 기록이 실패해도 뒤 기록은 이어서 나간다", async () => {
    void recordGenerationView("gA", { sceneId: "s", cardId: "cA" });
    void recordGenerationView("gB", { sceneId: "s", cardId: "cB" });
    await flush();
    // jsonFetch 목은 reject 경로가 없으므로 첫 요청을 '실패'로 흉내낸다 — 큐가 then(run, run) 으로 이어지는지가 요점.
    pending("PUT")[0].resolve(Promise.reject(new Error("네트워크")));
    await flush();
    await flush();
    expect(pending("PUT")).toHaveLength(2);
  });
});
