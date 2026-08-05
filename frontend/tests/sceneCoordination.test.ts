import { describe, expect, it } from "vitest";
import { mergePatchedSceneList } from "../src/lib/useSceneCoordination";
import type { Scene } from "../src/lib/scenes";

const scene = (id: string, name: string): Scene => ({
  id,
  name,
  cards: [],
  edges: [],
  created_at: 1,
});

describe("mergePatchedSceneList", () => {
  it("백그라운드 씬 갱신 중 현재 씬의 저장 전 메모리 상태를 보존한다", () => {
    const editing = scene("active", "입력 중");
    const previous = [editing, scene("background", "이전")];
    const latest = [scene("active", "저장된 옛 값"), scene("background", "생성 결과 반영")];

    const merged = mergePatchedSceneList(previous, latest, "active", "background");

    expect(merged[0]).toBe(editing);
    expect(merged[1].name).toBe("생성 결과 반영");
  });

  it("현재 씬 자체를 갱신한 경우 최신 결과를 그대로 반영한다", () => {
    const latest = [scene("active", "생성 결과 반영")];
    expect(
      mergePatchedSceneList([scene("active", "이전")], latest, "active", "active"),
    ).toBe(latest);
  });

  it("다른 탭이 현재 씬을 삭제했어도 백그라운드 갱신이 화면의 편집본을 제거하지 않는다", () => {
    const editing = scene("active", "편집 보존");
    const merged = mergePatchedSceneList(
      [editing, scene("background", "이전")],
      [scene("background", "결과 반영")],
      "active",
      "background",
    );
    expect(merged.map((item) => item.id)).toEqual(["active", "background"]);
    expect(merged[0]).toBe(editing);
  });
});
