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
    const ordinaryReload = state.beginReload();
    state.finishReload(ordinaryReload, true);
    expect(
      state.decide([{ client_id: "client_other_123", mutation_id: "mutation_other_123" }]),
    ).toBe("reload");
    expect(state.decide(undefined)).toBe("reload");
  });

  it("가드 안 bare 신호는 버리지 않고 가드 종료까지 미뤄 한 번 더 읽는다(유실 제거)", () => {
    let now = 10_000;
    const state = new LibrarySyncState("client_self_123", () => now);
    state.trackBareSyncedForReload();
    expect(state.decide(undefined)).toBe("wait");
    const reload = state.beginReload();

    expect(state.decide(undefined)).toBe("wait");
    state.finishReload(reload, true);
    expect(
      state.decide([{ client_id: "client_other_123", mutation_id: "mutation_other_123" }]),
    ).toBe("reload");
    // 가드 안 첫 bare — 반향인지 진짜 외부 변경인지 구분 불가 → skip 대신 wait(지연).
    expect(state.decide(undefined)).toBe("wait");
    now += 400;
    expect(state.decide(undefined)).toBe("wait"); // 가드가 끝날 때까지 유지
    now += 700;
    expect(state.decide(undefined)).toBe("reload"); // 가드 종료 → 지연 reload 실행
  });

  it("지연 reload 가 만든 다음 가드의 bare(반향 연쇄)만 끊고, 그 다음 기회는 다시 지연한다", () => {
    let now = 10_000;
    const state = new LibrarySyncState("client_self_123", () => now);
    // 1차 bare reload → 가드 → 가드 안 신호는 지연됐다가 reload 로 실행됨(위 테스트 경로).
    state.trackBareSyncedForReload();
    const first = state.beginReload();
    state.finishReload(first, true);
    expect(state.decide(undefined)).toBe("wait");
    now += 1_100;
    expect(state.decide(undefined)).toBe("reload");
    // 지연 reload(2차)가 실행되고 그 자신도 bare 로 시작한다.
    state.trackBareSyncedForReload();
    const second = state.beginReload();
    state.finishReload(second, true);
    // 2차 가드 안에서 또 bare = 구서버 반향 연쇄의 서명 — 여기서만 끊는다(무한 순환 차단).
    expect(state.decide(undefined)).toBe("skip");
    // 끊은 뒤 다음 독립 신호는 다시 지연이 허용된다(재무장) — 상시 유실로 돌아가지 않는다.
    expect(state.decide(undefined)).toBe("wait");
    now += 1_100;
    expect(state.decide(undefined)).toBe("reload");
  });

  it("출처 없는 신호의 reload가 실패하면 다음 신호로 즉시 재시도한다", () => {
    const state = new LibrarySyncState("client_self_123");
    state.trackBareSyncedForReload();
    const reload = state.beginReload();
    state.finishReload(reload, false);

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

  it("Assets·관리 요청은 라이브러리 pending과 분리하고 자기 알림만 한 번 소비한다", () => {
    const state = new LibrarySyncState("client_self_123");
    const assetOrigin = state.createMutationOrigin("PUT")!;
    const manageOrigin = state.createMutationOrigin("PATCH")!;
    state.markDomainsSucceeded(assetOrigin, assetOrigin.mutation_id, ["assets"]);
    state.markDomainsSucceeded(manageOrigin, manageOrigin.mutation_id, ["manage"]);

    expect(state.beginReload().mutationIds.size).toBe(0);
    expect(state.consumeOwnDomainSync("assets", [assetOrigin])).toBe(true);
    expect(state.consumeOwnDomainSync("assets", [assetOrigin])).toBe(false);
    expect(state.consumeOwnDomainSync("manage", [manageOrigin])).toBe(true);
  });

  it("도메인 알림에 다른 탭 변경이 섞이면 자기 요청이 있어도 갱신한다", () => {
    const state = new LibrarySyncState("client_self_123");
    const own = state.createMutationOrigin("POST")!;
    state.markDomainsSucceeded(own, own.mutation_id, ["assets"]);
    expect(
      state.consumeOwnDomainSync("assets", [
        own,
        { client_id: "client_other_123", mutation_id: "mutation_other_123" },
      ]),
    ).toBe(false);
  });
});
