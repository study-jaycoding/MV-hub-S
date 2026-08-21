import { describe, expect, it } from "vitest";
import { SCENE_NODE_CATALOG, SCENE_NODE_KEYS } from "./sceneNodeCatalog";

describe("SCENE_NODE_CATALOG", () => {
  it("kind·단축키가 중복 없이 유일하다", () => {
    const kinds = SCENE_NODE_CATALOG.map((e) => e.kind);
    const keys = SCENE_NODE_CATALOG.map((e) => e.key.toLowerCase());
    expect(new Set(kinds).size).toBe(kinds.length);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("키보드 매핑은 카탈로그에서 완전 파생된다(3중 선언 금지)", () => {
    expect(Object.keys(SCENE_NODE_KEYS)).toHaveLength(SCENE_NODE_CATALOG.length);
    for (const entry of SCENE_NODE_CATALOG) {
      expect(SCENE_NODE_KEYS[entry.key.toLowerCase()]).toBe(entry.kind);
    }
  });

  it("가져오기 전용 reference 는 생성 카탈로그에 없다", () => {
    expect(SCENE_NODE_CATALOG.some((e) => (e.kind as string) === "reference")).toBe(false);
  });

  it("현재 생성 가능한 노드는 11종이다 — 종류를 바꾸면 피커 높이·메뉴가 자동 추종한다", () => {
    expect(SCENE_NODE_CATALOG).toHaveLength(11);
  });
});
