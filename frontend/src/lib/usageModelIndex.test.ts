import { describe, expect, it } from "vitest";
import { groupModelRows } from "./usageModelIndex";

interface Row {
  creator_uid: string | null;
  model: string;
}

const row = (creator_uid: string | null, model: string): Row => ({ creator_uid, model });

describe("groupModelRows", () => {
  it("같은 키의 행을 원본 순서 그대로 묶는다", () => {
    const rows = [row("u1", "a"), row("u2", "b"), row("u1", "c")];
    const index = groupModelRows(rows, (r) => r.creator_uid);
    expect(index.get("u1")?.map((r) => r.model)).toEqual(["a", "c"]);
    expect(index.get("u2")?.map((r) => r.model)).toEqual(["b"]);
  });

  it("null과 빈 문자열 키를 서로 병합하지 않는다 (filter === 의미 보존)", () => {
    const rows = [row(null, "n1"), row("", "e1"), row(null, "n2")];
    const index = groupModelRows(rows, (r) => r.creator_uid);
    expect(index.get(null)?.map((r) => r.model)).toEqual(["n1", "n2"]);
    expect(index.get("")?.map((r) => r.model)).toEqual(["e1"]);
    expect(index.get(null)).not.toContain(rows[1]);
  });

  it("없는 키 조회와 undefined 입력은 빈 결과가 된다", () => {
    expect(groupModelRows(undefined, (r: Row) => r.creator_uid).size).toBe(0);
    const index = groupModelRows([row("u1", "a")], (r) => r.creator_uid);
    expect(index.get("없는키")).toBeUndefined();
  });

  it("filter 결과와 완전 동등하다 (내용·순서)", () => {
    const rows = [
      row("u1", "a"), row(null, "b"), row("u1", "c"), row("", "d"), row("u2", "e"),
    ];
    const index = groupModelRows(rows, (r) => r.creator_uid);
    for (const key of ["u1", "u2", null, "", "미존재"] as const) {
      const expected = rows.filter((r) => r.creator_uid === key);
      expect(index.get(key) || []).toEqual(expected);
    }
  });
});
