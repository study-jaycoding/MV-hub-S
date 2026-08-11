import { describe, expect, it } from "vitest";
import {
  encodeSceneFolderDrag,
  parseSceneFolderDrag,
  parseSceneSetTags,
} from "../src/lib/sceneSet";

describe("sceneSet", () => {
  it("쉼표·줄바꿈 태그를 정리하고 중복을 제거한다", () => {
    expect(parseSceneSetTags(" hero, #night\nHero,  final ")).toEqual([
      "hero",
      "night",
      "final",
    ]);
  });

  it("폴더 드래그 정보를 정규화하고 안전하지 않은 경로는 거부한다", () => {
    const encoded = encodeSceneFolderDrag({
      projectId: "p1",
      projectName: "프로젝트",
      path: "ep001\\c0010",
    });
    expect(parseSceneFolderDrag(encoded)).toEqual({
      projectId: "p1",
      projectName: "프로젝트",
      path: "ep001/c0010",
    });
    expect(parseSceneFolderDrag(JSON.stringify({ projectId: "p1", path: "../outside" }))).toBeNull();
    expect(parseSceneFolderDrag("not-json")).toBeNull();
  });
});
