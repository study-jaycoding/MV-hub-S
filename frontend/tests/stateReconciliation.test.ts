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

  it("중첩 Assets 트리가 같으면 전체 참조를 유지하고 파일 버전 변경은 반영한다", () => {
    const previous = [
      {
        name: "Render",
        type: "dir",
        path: "Render",
        children: [{ name: "shot.png", type: "image", path: "Render/shot.png", version: "1" }],
      },
    ];
    expect(reconcileArrayState(previous, structuredClone(previous))).toBe(previous);

    const changed = structuredClone(previous);
    changed[0].children[0].version = "2";
    const reconciled = reconcileArrayState(previous, changed);
    expect(reconciled).not.toBe(previous);
    expect(reconciled).toEqual(changed);
    expect(reconciled[0]).toBe(changed[0]);
  });

  it("동일한 관리 작업표 응답은 컷·담당자까지 비교해 이전 배열을 유지한다", () => {
    const previous = [
      {
        id: "task-1",
        status: "progress",
        cuts: [{ id: "gen-1", is_final: false }],
        assigned_creators: [{ uid: "user-1", name: "Jay" }],
      },
    ];

    expect(reconcileArrayState(previous, structuredClone(previous))).toBe(previous);

    const changed = structuredClone(previous);
    changed[0].cuts[0].is_final = true;
    const reconciled = reconcileArrayState(previous, changed);
    expect(reconciled).not.toBe(previous);
    expect(reconciled[0]).toBe(changed[0]);
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

  it("폴더 카운트 일부를 병합해도 값이 같으면 전체 state 참조를 유지한다", () => {
    const previous = {
      projectA: { ep001: 3, "ep001/c0010": 3 },
      projectB: { render: 2 },
    };
    const samePatch = {
      ...previous,
      projectA: { ep001: 3, "ep001/c0010": 3 },
    };
    expect(reconcileRecordState(previous, samePatch)).toBe(previous);

    const changedPatch = {
      ...previous,
      projectA: { ep001: 4, "ep001/c0010": 3 },
    };
    const reconciled = reconcileRecordState(previous, changedPatch);
    expect(reconciled).not.toBe(previous);
    expect(reconciled.projectB).toBe(previous.projectB);
  });
});
