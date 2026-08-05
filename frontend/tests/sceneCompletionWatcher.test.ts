import { describe, expect, it } from "vitest";
import { buildSceneCompletionPollIds } from "../src/lib/useSceneCompletionWatcher";

describe("buildSceneCompletionPollIds", () => {
  it("현재 SceneBoard가 담당하는 id만 제외하고 다른 씬 watch는 유지한다", () => {
    const ids = buildSceneCompletionPollIds(
      ["active-a", "background-a", "background-b"],
      ["active-a", "active-b"],
      new Set(["active-a", "active-b"]),
      () => false,
    );
    expect(ids).toEqual(["background-a", "background-b"]);
  });

  it("모르는 후보만 상한까지 발견하고 watch와 중복하지 않는다", () => {
    const known = new Set(["known"]);
    const ids = buildSceneCompletionPollIds(
      ["watch", "same"],
      ["known", "same", "new-a", "new-b", "new-c"],
      new Set(),
      (id) => known.has(id),
      2,
    );
    expect(ids).toEqual(["watch", "same", "new-a", "new-b"]);
  });

  it("모든 대상이 현재 SceneBoard에 포함되면 API 조회 목록을 비운다", () => {
    expect(
      buildSceneCompletionPollIds(
        ["a"],
        ["a", "b"],
        new Set(["a", "b"]),
        () => false,
      ),
    ).toEqual([]);
  });
});
