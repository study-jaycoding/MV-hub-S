// buildRecipeScene — 생성물 → recipe 씬(노드+연결) 변환 특성화.
import { describe, it, expect } from "vitest";
import { buildRecipeScene } from "../src/lib/recipeScene";
import type { Generation, History } from "../src/types";

function gen(overrides: Partial<Generation>): Generation {
  return {
    id: "g1",
    references: [],
    model: null,
    params: null,
    prompt: "",
    display_prompt: null,
    ...overrides,
  } as Generation;
}

describe("buildRecipeScene", () => {
  it("레퍼런스·모델·프롬프트 → 각 입력 노드 + 결과 카드, 엣지는 결과로 역할별", () => {
    const g = gen({
      id: "res1",
      model: "seedance",
      params: { steps: 20, extra: { a: 1 } },
      prompt: "a cat",
      display_prompt: "a @cat",
      references: [
        { id: "r1", type: "image", file_path: "p1", thumbnail_path: "t1", source: "cat", role: null, source_url: null, cached: true },
      ],
    });
    const s = buildRecipeScene(g);

    expect(s.cards.some((c) => c.kind === "reference")).toBe(true);
    expect(s.cards.some((c) => c.kind === "model")).toBe(true);
    expect(s.cards.some((c) => c.kind === "text")).toBe(true);

    const gens = s.cards.filter((c) => c.kind === "generation");
    expect(gens).toHaveLength(1); // 결과만
    const result = gens[0];
    expect(result.genId).toBe("res1");

    // 모든 엣지는 결과 카드로 향하고 역할이 있다.
    expect(s.edges.every((e) => e.to === result.id)).toBe(true);
    expect(s.edges.map((e) => e.role).sort()).toEqual(["model", "ref", "text"]);

    // params 의 객체 값은 짧은 문자열로 정규화, primitive 는 그대로.
    const model = s.cards.find((c) => c.kind === "model")!;
    expect(model.modelCfg?.params?.steps).toBe(20);
    expect(typeof model.modelCfg?.params?.extra).toBe("string");

    // 텍스트는 display_prompt 우선.
    expect(s.cards.find((c) => c.kind === "text")!.text).toBe("a @cat");
  });

  it("history 의 재료(@소스)·직속 부모 → 1단계 위 생성물 노드", () => {
    const g = gen({ id: "res2", prompt: "x" });
    const history = {
      ancestors: [{ id: "parent1" }],
      materials: [{ id: "mat1" }],
      target: {} as Generation,
      children: [],
      used_by: [],
      siblings: [],
    } as unknown as History;

    const s = buildRecipeScene(g, history);
    const gens = s.cards.filter((c) => c.kind === "generation");
    expect(gens).toHaveLength(3); // 결과 + 재료 + 부모
    expect(s.edges.some((e) => e.role === "lineage")).toBe(true); // 부모=lineage
  });

  it("자기 자신이 materials/ancestors 에 있어도 중복 노드로 넣지 않는다", () => {
    const g = gen({ id: "self", prompt: "x" });
    const history = {
      ancestors: [{ id: "self" }],
      materials: [{ id: "self" }],
      target: {} as Generation,
      children: [],
      used_by: [],
      siblings: [],
    } as unknown as History;
    const s = buildRecipeScene(g, history);
    expect(s.cards.filter((c) => c.kind === "generation")).toHaveLength(1); // 결과만
  });
});
