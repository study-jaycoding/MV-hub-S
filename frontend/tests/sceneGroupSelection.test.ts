import { describe, expect, it } from "vitest";
import {
  sceneGroupClickSelection,
  sceneGroupControlTargetIds,
  sceneGroupDragTargetIds,
} from "../src/lib/sceneGroupSelection";

describe("scene group selection", () => {
  it("일반 클릭은 그룹 하나만 선택하고 내부 카드 선택으로 바꾸지 않는다", () => {
    expect([...sceneGroupClickSelection(new Set(["g1", "g2"]), "g3", false)]).toEqual(["g3"]);
  });

  it("Ctrl/Shift 클릭은 그룹 선택을 추가하거나 제거한다", () => {
    expect([...sceneGroupClickSelection(new Set(["g1"]), "g2", true)]).toEqual(["g1", "g2"]);
    expect([...sceneGroupClickSelection(new Set(["g1", "g2"]), "g1", true)]).toEqual(["g2"]);
  });

  it("선택된 그룹을 잡으면 복수 그룹 전체가 드래그 대상이 된다", () => {
    expect(sceneGroupDragTargetIds(new Set(["g1", "g2"]), "g2", false)).toEqual(["g1", "g2"]);
    expect(sceneGroupDragTargetIds(new Set(["g1"]), "g2", true)).toEqual(["g1", "g2"]);
    expect(sceneGroupDragTargetIds(new Set(["g1"]), "g2", false)).toEqual(["g2"]);
  });

  it("선택된 그룹의 색상 버튼은 복수 선택 전체를 제어한다", () => {
    expect(sceneGroupControlTargetIds(new Set(["g1", "g2"]), "g1")).toEqual(["g1", "g2"]);
    expect(sceneGroupControlTargetIds(new Set(["g1", "g2"]), "g3")).toEqual(["g3"]);
  });
});
