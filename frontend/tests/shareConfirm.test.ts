// Jay 결정 10A(10-15) — 공유 서버가 60초 넘게 늦으면 허브가 '실패' 대신 결과 불명(502 + 원장 참조)으로 돌려주고,
//  화면은 '확인 중'으로 센 뒤 원장으로 끝을 묻는다. 설계 docs/status/결정일곱_설계_2026-10-15.md 10A.
import { afterEach, describe, expect, it, vi } from "vitest";

const answers = vi.hoisted(() => new Map<string, Array<{ state: string; reason?: string }>>());
const asked = vi.hoisted(() => [] as number[]); // 묻기 한 번에 실은 참조 수
vi.mock("../src/lib/http", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/http")>();
  return {
    ...real,
    // 가짜 허브의 묶음 묻기(POST /api/share/intents/outcomes) — 답이 하나도 없으면 허브 불통(거절)
    jsonFetch: (_url: string, init?: RequestInit) => {
      const refs = (JSON.parse(String(init?.body ?? "{}")).refs ?? []) as Array<{ intent_id: string; seq: number }>;
      asked.push(refs.length);
      if (refs.some((ref) => ref.intent_id === "hang")) return new Promise(() => {}); // 응답이 끝나지 않는다
      const out = refs.flatMap((ref) => {
        const queue = answers.get(key(ref.intent_id, ref.seq)) ?? [];
        const next = queue.length > 1 ? queue.shift()! : queue[0];
        return next ? [{ ...next, intent_id: ref.intent_id, seq: ref.seq }] : [];
      });
      return out.length ? Promise.resolve(out) : Promise.reject(new TypeError("Failed to fetch"));
    },
  };
});

import { HttpError, throwHttpError } from "../src/lib/http";
import { settledSummary, settleIntents, slowRefs } from "../src/lib/shareConfirm";

function key(id: string, seq: number) {
  return `${id}:${seq}`;
}
afterEach(() => {
  answers.clear();
  asked.length = 0;
});

describe("늦은 서버의 오류 모양", () => {
  it("허브의 구조화된 오류는 글(message)과 원장 참조(info)로 나뉜다 — 일반 오류는 원장 참조가 없다", async () => {
    const refs = [{ gen_id: "g1", intent_id: "i1", seq: 3 }];
    const body = { detail: { code: "upstream_timeout", message: "서버가 늦습니다 — 들어갔는지 확인하는 중입니다", refs } };
    const slow = await throwHttpError(new Response(JSON.stringify(body), { status: 502 }), "/api/generations/g1/finalize").catch((e) => e);
    expect(slow).toBeInstanceOf(HttpError);
    expect([slow.detail, slowRefs(slow)]).toEqual(["서버가 늦습니다 — 들어갔는지 확인하는 중입니다", refs]);
    const plain = await throwHttpError(new Response(JSON.stringify({ detail: "공유 서버 연결 실패" }), { status: 502 }), "/x").catch((e) => e);
    expect([plain.detail, slowRefs(plain)]).toEqual(["공유 서버 연결 실패", null]);
    expect(slowRefs(new TypeError("Failed to fetch"))).toBeNull();
  });
});

describe("원장으로 끝을 묻기", () => {
  it("확인 중이면 다시 묻고, 끝난 것은 반영·실패·확인 불가로 세며, 기한이 지나도 안 끝난 것은 확인 불가다", async () => {
    answers.set(key("a", 1), [{ state: "pending" }, { state: "confirmed" }]);
    answers.set(key("b", 1), [{ state: "failed", reason: "composite_reverted" }]);
    answers.set(key("c", 2), [{ state: "unknown" }]);
    answers.set(key("d", 1), [{ state: "pending" }]); // 끝나지 않는다
    const counts = await settleIntents(
      [{ gen_id: "g1", intent_id: "a", seq: 1 }, { gen_id: "g2", intent_id: "b", seq: 1 },
       { gen_id: "g3", intent_id: "c", seq: 2 }, { gen_id: "g4", intent_id: "d", seq: 1 }],
      1, 30,
    );
    expect(counts).toEqual({ confirmed: 1, failed: 1, unknown: 2, reasons: ["composite_reverted"] });
    expect(settledSummary(counts)).toBe(
      "늦었던 요청 확인: 반영 1 · 실패 1 · 확인 불가 2 · 최종 지정이 들어가지 않아 공유도 되돌렸습니다 · 확인하지 못한 것은 카드 상태를 보세요.");
  });

  it("참조가 많아도 한 바퀴는 묶음 몇 번이다(500개씩) — 하나씩 묻지 않는다(Codex 63회차)", async () => {
    const refs = Array.from({ length: 1200 }, (_, i) => ({ gen_id: `g${i}`, intent_id: `i${i}`, seq: 1 }));
    for (const ref of refs) answers.set(key(ref.intent_id, 1), [{ state: "confirmed" }]);
    const counts = await settleIntents(refs, 1, 5000);
    expect(counts.confirmed).toBe(1200);
    expect(asked).toEqual([500, 500, 200]);
  });

  it("응답이 끝나지 않아도 기한에 끊고 확인 불가로 센다 — 기다림이 기한을 넘지 않는다(Codex 10A 리뷰)", async () => {
    const started = Date.now();
    const counts = await settleIntents([{ gen_id: "g1", intent_id: "hang", seq: 1 }], 1, 40);
    expect(counts.unknown).toBe(1);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("다음 묻기까지의 기다림도 기한을 넘지 않는다(Codex 10A 재검토)", async () => {
    answers.set(key("slowpoke", 1), [{ state: "pending" }]);
    const started = Date.now();
    const counts = await settleIntents([{ gen_id: "g1", intent_id: "slowpoke", seq: 1 }], 10_000, 40);
    expect(counts.unknown).toBe(1);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("묻기 자체가 실패하면(허브 불통) 끝난 것으로 세지 않고 다시 묻는다", async () => {
    const refs = [{ gen_id: "g1", intent_id: "x", seq: 1 }];
    const counts = await settleIntents(refs, 1, 200); // 답이 없다(목록에 없음 → 거절)
    expect(counts).toEqual({ confirmed: 0, failed: 0, unknown: 1, reasons: [] });
    expect(asked.length).toBeGreaterThan(1);
  });
});
