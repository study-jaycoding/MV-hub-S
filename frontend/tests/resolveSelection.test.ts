import { describe, expect, it } from "vitest";
import type { Scene, SceneCard } from "../src/lib/scenes";
import {
  resolveCardForGeneration,
  resolveSceneForGeneration,
  resolveSelectionGenerationIds,
} from "../src/lib/resolveSelection";

const card = (id: string, genId: string, genIds: string[]): SceneCard => ({
  id,
  kind: "generation",
  x: 0,
  y: 0,
  genId,
  genIds,
});

const scene = (id: string, createdAt: number, cards: SceneCard[]): Scene => ({
  id,
  name: id,
  cards,
  edges: [],
  created_at: createdAt,
});

describe("Resolve 선택이 열 캔버스와 결과 카드", () => {
  it("생성물이 현재 캔버스에 있으면 현재 캔버스를 유지한다", () => {
    const scenes = [
      scene("active", 1, [card("a", "g-old", ["g-old", "target"])]),
      scene("newer", 9, [card("b", "target", ["target"])]),
    ];

    expect(resolveSceneForGeneration(scenes, "active", "target")?.id).toBe("active");
  });

  it("현재 캔버스에 없으면 생성물이 든 가장 최근 캔버스를 연다", () => {
    const scenes = [
      scene("older", 2, [card("a", "target", ["target"])]),
      scene("newer", 8, [card("b", "other", ["other", "target"])]),
    ];

    expect(resolveSceneForGeneration(scenes, null, "target")?.id).toBe("newer");
  });

  it("이미 열린 카드가 목표를 담고 있으면 그 팝업을 그대로 사용한다", () => {
    const cards = [
      card("first", "target", ["target"]),
      card("open", "other", ["other", "target"]),
    ];

    expect(resolveCardForGeneration(cards, "open", "target")?.id).toBe("open");
  });

  it("열린 카드가 없으면 목표가 대표인 카드를 우선한다", () => {
    const cards = [
      card("contains", "other", ["other", "target"]),
      card("representative", "target", ["target"]),
    ];

    expect(resolveCardForGeneration(cards, null, "target")?.id).toBe("representative");
  });

  it("배열은 중복을 없애고 빈 배열은 구형 단일 ID보다 우선한다", () => {
    expect(resolveSelectionGenerationIds(["target", "target", "other", "", null], "legacy"))
      .toEqual(["target", "other"]);
    expect(resolveSelectionGenerationIds([], "legacy")).toEqual([]);
    expect(resolveSelectionGenerationIds(undefined, "legacy")).toEqual(["legacy"]);
  });

  it("복수 ID 중 하나라도 현재 씬에 있으면 첫 ID가 다른 씬에 있어도 현재 씬을 유지한다", () => {
    const scenes = [
      scene("active", 1, [card("a", "target", ["target"])]),
      scene("newer", 9, [card("b", "other", ["other"])]),
    ];
    expect(resolveSceneForGeneration(scenes, "active", ["other", "target"])?.id).toBe("active");
    expect(resolveSceneForGeneration(scenes, null, ["target", "other"])?.id).toBe("newer");
  });

  it("복수 선택은 열린 묶음의 일치를 우선하고 없으면 대표가 일치하는 한 묶음을 고른다", () => {
    const cards = [
      card("contains", "other", ["other", "target"]),
      card("representative", "target", ["target"]),
      card("open", "last", ["last", "second"]),
    ];
    expect(resolveCardForGeneration(cards, "open", ["target", "second"])?.id).toBe("open");
    expect(resolveCardForGeneration(cards, null, ["target", "second"])?.id).toBe("representative");
    expect(resolveCardForGeneration(cards, null, [])).toBeNull();
  });
});
