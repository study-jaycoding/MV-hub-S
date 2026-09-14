// WS progress 한 건을 카드에 반영하는 규칙을 고정한다.
//  · 서버가 말한 것만 바꾸고, 말하지 않은 것은 그대로 둔다.
//  · 2026-09-14 회귀: running 이라고 error 를 지우자 '확인 중' 배지가 '생성중' 으로 되돌아갔다.
import { describe, expect, it } from "vitest";

import { isVerifying } from "./generationDisplay";
import { applyProgressToGen } from "./useGenerationProgress";
import type { Generation, ProgressMessage } from "../types";

const card = (over: Partial<Generation> = {}) =>
  ({ id: "g1", status: "running", error: null, ...over }) as Generation;

describe("applyProgressToGen", () => {
  it("서버가 사유를 담으면 반영한다", () => {
    const next = applyProgressToGen(card(), { type: "progress", status: "failed", error: "NSFW 차단" } as ProgressMessage);
    expect(next.status).toBe("failed");
    expect(next.error).toBe("NSFW 차단");
  });

  it("서버가 빈 사유를 명시하면 지운다", () => {
    const next = applyProgressToGen(card({ error: "옛 사유" }), { type: "progress", status: "done", error: null } as unknown as ProgressMessage);
    expect(next.error).toBeNull();
  });

  it("★서버가 사유를 안 담은 메시지는 기존 사유를 건드리지 않는다", () => {
    const before = card({ error: "확인중 — 실제 상태 재확인 대기" });
    const next = applyProgressToGen(before, { type: "progress", status: "running" } as ProgressMessage);
    expect(next.error).toBe(before.error);
    expect(isVerifying(next.status, next.error)).toBe(true);   // 배지가 '확인 중' 을 유지한다
  });
});
