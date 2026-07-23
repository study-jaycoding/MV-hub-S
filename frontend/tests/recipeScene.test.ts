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
    // 결과 카드에 refs 가 있어 클릭 시 프롬프트에 붙는다(from_card).
    expect(result.refs).toHaveLength(1);
    expect(result.refs?.[0].from_card).toBe(true);
    expect(result.refs?.[0].file_path).toBe("p1");

    // 모든 엣지는 결과 카드로 향하고 역할이 있다.
    expect(s.edges.every((e) => e.to === result.id)).toBe(true);
    expect(s.edges.map((e) => e.role).sort()).toEqual(["model", "ref", "text"]);

    // params: primitive 는 그대로, 객체/배열은 제외(재생성 시 잘못 제출 방지).
    const model = s.cards.find((c) => c.kind === "model")!;
    expect(model.modelCfg?.params?.steps).toBe(20);
    expect(model.modelCfg?.params?.extra).toBeUndefined();

    // 텍스트는 display_prompt 우선.
    expect(s.cards.find((c) => c.kind === "text")!.text).toBe("a @cat");
  });

  it("레퍼런스 file_path 는 source_url(원본 토큰/URL) 우선 — 팀·교차서버 해석용", () => {
    const g = gen({
      id: "res3",
      references: [
        {
          id: "r1",
          type: "image",
          file_path: "/cache/local/abc.png", // 캐시 경로(교차서버에서 안 풀림)
          thumbnail_path: "t1",
          source: "cat",
          role: null,
          source_url: "https://cdn.example/orig.png", // 원본 URL
          cached: true,
        },
      ],
    });
    const s = buildRecipeScene(g);
    const refCard = s.cards.find((c) => c.kind === "reference")!;
    expect(refCard.refs?.[0].file_path).toBe("https://cdn.example/orig.png");
    // 결과 카드 refs 도 같은 원본을 써 dedup 키가 레퍼런스 카드와 일관된다.
    const result = s.cards.find((c) => c.kind === "generation")!;
    expect(result.refs?.[0].file_path).toBe("https://cdn.example/orig.png");
  });

  it("레퍼런스가 재료(@소스) 생성물에서 왔으면 source_gen_id 로 되짚어 계보를 기록", () => {
    const g = gen({
      id: "res5",
      references: [
        // 이 레퍼런스의 source_url 이 재료 mat1 의 에셋과 일치 → source_gen_id=mat1 이어야.
        { id: "r1", type: "image", file_path: "/cache/x.png", thumbnail_path: "t", source: "s", role: null, source_url: "https://cdn/mat1.png", cached: true },
        // 매칭 재료 없음 → source_gen_id 없음.
        { id: "r2", type: "image", file_path: "asset:p|y.png", thumbnail_path: "t", source: "s", role: null, source_url: null, cached: true },
      ],
    });
    const history = {
      ancestors: [],
      materials: [
        { id: "mat1", assets: [{ id: "a1", generation_id: "mat1", type: "image", file_path: "/media/mat1_local.png", thumbnail_path: null, source_url: "https://cdn/mat1.png", cached: true }] },
      ],
      target: {} as Generation,
      children: [],
      used_by: [],
      siblings: [],
    } as unknown as History;
    const s = buildRecipeScene(g, history);
    const result = s.cards.filter((c) => c.kind === "generation").find((c) => c.genId === "res5")!;
    expect(result.refs?.find((r) => r.file_path === "https://cdn/mat1.png")?.source_gen_id).toBe("mat1");
    expect(result.refs?.find((r) => r.file_path === "asset:p|y.png")?.source_gen_id).toBeUndefined();
  });

  it("source_url 이 없으면 file_path 로 폴백", () => {
    const g = gen({
      id: "res4",
      references: [
        { id: "r1", type: "image", file_path: "asset:proj|p.png", thumbnail_path: "t1", source: "s", role: null, source_url: null, cached: true },
      ],
    });
    const s = buildRecipeScene(g);
    expect(s.cards.find((c) => c.kind === "reference")!.refs?.[0].file_path).toBe("asset:proj|p.png");
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
