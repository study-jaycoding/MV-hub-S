import { describe, expect, it } from "vitest";
import {
  isStructurallyEqual,
  reconcileArrayState,
  reconcileRecordState,
  reconcileValueState,
} from "../src/lib/stateReconciliation";

describe("stateReconciliation", () => {
  it("객체 키 순서가 달라도 같은 JSON 내용으로 판단한다", () => {
    expect(
      isStructurallyEqual(
        { id: "a", params: { prompt: "same", seed: 7 }, tags: ["x", "y"] },
        { tags: ["x", "y"], params: { seed: 7, prompt: "same" }, id: "a" },
      ),
    ).toBe(true);
  });

  it("중첩 값이나 배열 순서가 바뀌면 변경으로 판단한다", () => {
    expect(isStructurallyEqual({ params: { seed: 7 } }, { params: { seed: 8 } })).toBe(false);
    expect(isStructurallyEqual({ tags: ["x", "y"] }, { tags: ["y", "x"] })).toBe(false);
  });

  it("동일한 값과 배열은 이전 state 참조를 유지한다", () => {
    const previousValue = { failed_count: 1, has_unread: false };
    const previousArray = [{ id: "a", count: 2 }, { id: "b", count: 3 }];

    expect(reconcileValueState(previousValue, { failed_count: 1, has_unread: false })).toBe(previousValue);
    expect(reconcileArrayState(previousArray, [{ id: "a", count: 2 }, { id: "b", count: 3 }])).toBe(
      previousArray,
    );
  });

  it("배열 일부만 바뀌면 새 배열에서 동일한 항목 참조를 재사용한다", () => {
    const previous = [{ id: "a", count: 2 }, { id: "b", count: 3 }];
    const next = reconcileArrayState(previous, [{ id: "a", count: 2 }, { id: "b", count: 4 }]);

    expect(next).not.toBe(previous);
    expect(next[0]).toBe(previous[0]);
    expect(next[1]).not.toBe(previous[1]);
  });

  it("레코드가 같으면 전체 참조를 유지하고 변경·삭제는 반영한다", () => {
    const previous = {
      a: { status: "done", tags: ["x"] },
      b: { status: "done", tags: [] },
    };
    expect(
      reconcileRecordState(previous, {
        a: { status: "done", tags: ["x"] },
        b: { status: "done", tags: [] },
      }),
    ).toBe(previous);

    const next = reconcileRecordState(previous, { a: { status: "failed", tags: ["x"] } });
    expect(next).toEqual({ a: { status: "failed", tags: ["x"] } });
    expect(next).not.toHaveProperty("b");
  });
});
