import { describe, expect, it } from "vitest";
import { LibrarySyncState } from "../src/lib/librarySync";

describe("LibrarySyncState", () => {
  it("내 변경을 포함한 목록 reload가 성공하면 뒤늦은 synced 전체 조회를 생략한다", () => {
    const state = new LibrarySyncState("client_self_123");
    const origin = state.createMutationOrigin("POST")!;
    state.markMutationSucceeded(origin, origin.mutation_id);
    const reload = state.beginReload();
    state.finishReload(reload, true);

    expect(state.decide([origin])).toBe("skip");
    expect(state.decide([origin])).toBe("reload"); // 같은 요청 id 재사용은 한 번만 생략
  });

  it("내 변경을 포함한 reload가 진행 중이면 기다리고 실패하면 다시 조회한다", () => {
    const state = new LibrarySyncState("client_self_123");
    const origin = state.createMutationOrigin("PATCH")!;
    state.markMutationSucceeded(origin, origin.mutation_id);
    const reload = state.beginReload();

    expect(state.decide([origin])).toBe("wait");
    state.finishReload(reload, false);
    expect(state.decide([origin])).toBe("reload");
  });

  it("같은 탭 요청이어도 자체 reload가 없으면 synced가 최신 목록을 조회한다", () => {
    const state = new LibrarySyncState("client_self_123");
    const origin = state.createMutationOrigin("DELETE")!;
    state.markMutationSucceeded(origin, origin.mutation_id);

    expect(state.decide([origin])).toBe("reload");
  });

  it("다른 탭·출처 없는 syncer 알림은 최근 자체 reload와 무관하게 반영한다", () => {
    const state = new LibrarySyncState("client_self_123");
    expect(
      state.decide([{ client_id: "client_other_123", mutation_id: "mutation_other_123" }]),
    ).toBe("reload");
    expect(state.decide(undefined)).toBe("reload");
  });

  it("요청 완료 순서가 뒤집혀도 개별 id 기준으로 덮인 변경만 판단한다", () => {
    const state = new LibrarySyncState("client_self_123");
    const slow = state.createMutationOrigin("POST")!;
    const fast = state.createMutationOrigin("POST")!;
    state.markMutationSucceeded(fast, fast.mutation_id);
    const reload = state.beginReload();
    state.finishReload(reload, true);

    state.markMutationSucceeded(slow, slow.mutation_id);
    expect(state.decide([fast])).toBe("skip");
    expect(state.decide([slow])).toBe("reload");
  });

  it("서버 알림이 HTTP 응답보다 먼저 와도 곧 시작한 reload가 그 요청을 덮는다", () => {
    const state = new LibrarySyncState("client_self_123");
    const origin = state.createMutationOrigin("PUT")!;
    state.trackOwnSyncedForReload([origin]);
    const reload = state.beginReload();
    expect(reload.mutationIds.has(origin.mutation_id)).toBe(true);
    state.finishReload(reload, true);

    // 늦게 도착한 HTTP echo가 이미 덮은 요청을 pending으로 되살리지 않는다.
    state.markMutationSucceeded(origin, origin.mutation_id);
    expect(state.decide([origin])).toBe("skip");
    expect(state.beginReload().mutationIds.size).toBe(0);
  });
});
