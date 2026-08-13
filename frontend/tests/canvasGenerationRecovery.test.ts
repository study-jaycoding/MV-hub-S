import { describe, expect, it } from "vitest";
import {
  prepareCanvasGenerationLinks,
  discardCanvasGenerationAttempt,
  reconcileCanvasGenerationAttempts,
  settleCanvasGenerationAttempt,
  type CanvasGenerationLink,
} from "../src/lib/canvasGenerationRecovery";
import type { SceneCard } from "../src/lib/scenes";

const card = (over: Partial<SceneCard> = {}): SceneCard => ({
  id: "card-a",
  kind: "generation",
  x: 0,
  y: 0,
  ...over,
});

const link = (over: Partial<CanvasGenerationLink> = {}): CanvasGenerationLink => ({
  attempt_id: "attempt_1234567890",
  generation_id: "generation_1234567890",
  scene_id: "scene-a",
  card_id: "card-a",
  ...over,
});

describe("canvasGenerationRecovery", () => {
  it("HTTP 요청 전에 generation id와 복구 표식을 카드에 저장한다", () => {
    const result = prepareCanvasGenerationLinks([card({ genIds: ["old"] })], [link()], 1000);

    expect(result.attachedCount).toBe(1);
    expect(result.cards[0]).toMatchObject({
      genId: "generation_1234567890",
      genIds: ["old", "generation_1234567890"],
      status: "pending",
      pendingGenerationAttempts: [{
        attemptId: "attempt_1234567890",
        generationId: "generation_1234567890",
        createdAt: 1000,
      }],
    });
  });

  it("재시작 뒤 같은 씬·카드·generation 연결만 자동 복구한다", () => {
    const prepared = prepareCanvasGenerationLinks([card()], [link()], 1000).cards;
    const recovered = reconcileCanvasGenerationAttempts(
      prepared,
      "scene-a",
      [{ ...link(), request_status: "pending" }],
      1500,
    );

    expect(recovered.recovered).toBe(1);
    expect(recovered.discarded).toBe(0);
    expect(recovered.cards[0].pendingGenerationAttempts).toBeUndefined();
    expect(recovered.cards[0].genIds).toContain("generation_1234567890");
  });

  it("다른 계정/카드처럼 불일치하는 연결은 채택하지 않고 유예 중 보존한다", () => {
    const prepared = prepareCanvasGenerationLinks([card()], [link()], 1000).cards;
    const result = reconcileCanvasGenerationAttempts(
      prepared,
      "scene-a",
      [{ ...link(), card_id: "foreign-card" }],
      2000,
      120_000,
    );

    expect(result.recovered).toBe(0);
    expect(result.discarded).toBe(0);
    expect(result.cards).toBe(prepared);
  });

  it("placeholder만 남은 종료 지점은 서버가 요청행을 복원한 뒤 채택한다", () => {
    const prepared = prepareCanvasGenerationLinks([card()], [link()], 1000).cards;
    const result = reconcileCanvasGenerationAttempts(
      prepared,
      "scene-a",
      [{ ...link(), request_status: "pending" }],
      2000,
    );

    expect(result.recovered).toBe(1);
    expect(result.cards[0].pendingGenerationAttempts).toBeUndefined();
  });

  it("서버에 도달하지 않은 오래된 표식만 제거하고 기존 결과는 보존한다", () => {
    const prepared = prepareCanvasGenerationLinks(
      [card({ genId: "old", genIds: ["old"] })],
      [link()],
      1000,
    ).cards;
    const result = reconcileCanvasGenerationAttempts(
      prepared,
      "scene-a",
      [],
      122_000,
      120_000,
    );

    expect(result.discarded).toBe(1);
    expect(result.cards[0]).toMatchObject({ genId: "old", genIds: ["old"] });
    expect(result.cards[0].pendingGenerationAttempts).toBeUndefined();
  });

  it("배치 응답 순서가 뒤바뀌어도 요청 전 정한 첫 장 대표를 유지한다", () => {
    const first = link();
    const second = link({
      attempt_id: "attempt_2222222222",
      generation_id: "generation_2222222222",
    });
    const prepared = prepareCanvasGenerationLinks([card()], [first, second], 1000).cards;
    const afterSecond = settleCanvasGenerationAttempt(
      prepared,
      "card-a",
      second.generation_id,
    );
    const afterFirst = settleCanvasGenerationAttempt(
      afterSecond,
      "card-a",
      first.generation_id,
    );

    expect(afterFirst[0].genId).toBe(first.generation_id);
    expect(afterFirst[0].genIds).toEqual([first.generation_id, second.generation_id]);
    expect(afterFirst[0].pendingGenerationAttempts).toBeUndefined();
  });

  it("서버가 확실히 거절한 요청 표식만 즉시 제거한다", () => {
    const prepared = prepareCanvasGenerationLinks(
      [card({ genId: "old", genIds: ["old"] })],
      [link()],
      1000,
    ).cards;
    const discarded = discardCanvasGenerationAttempt(
      prepared,
      "card-a",
      "generation_1234567890",
    );

    expect(discarded[0]).toMatchObject({ genId: "old", genIds: ["old"] });
    expect(discarded[0].pendingGenerationAttempts).toBeUndefined();
  });
});
