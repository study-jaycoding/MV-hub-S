// sceneEdges 순수 그래프/기하 특성화 — SceneBoard 엣지 렌더의 안전망(이번 리팩토링으로 추출).
import { describe, it, expect } from "vitest";
import {
  edgePathXY,
  fanOffset,
  computeBridgeEdges,
  classifyEdges,
} from "../src/lib/sceneEdges";
import type { SceneCard, SceneEdge } from "../src/lib/scenes";

const gen = (id: string, over: Partial<SceneCard> = {}): SceneCard => ({
  id,
  kind: "generation",
  x: 0,
  y: 0,
  genId: id,
  genIds: [id],
  ...over,
});

describe("edgePathXY", () => {
  it("베지어 path(d) 문자열 — 제어점은 x 중앙", () => {
    expect(edgePathXY(0, 0, 10, 20)).toBe("M 0 0 C 5 0, 5 20, 10 20");
  });
});

describe("fanOffset", () => {
  it("연결 1개 이하면 오프셋 0(정중앙)", () => {
    expect(fanOffset(undefined, "x", 13)).toBe(0);
    expect(fanOffset([{ id: "a" } as SceneEdge], "a", 13)).toBe(0);
  });
  it("연결 2개면 -fan/2, +fan/2 로 펼침", () => {
    const list = [{ id: "a" }, { id: "b" }] as SceneEdge[];
    expect(fanOffset(list, "a", 13)).toBe(-6.5);
    expect(fanOffset(list, "b", 13)).toBe(6.5);
  });
});

describe("computeBridgeEdges", () => {
  it("숨긴 중간 노드를 건너뛴 우회선을 만든다", () => {
    const cards = [gen("A"), gen("M"), gen("B")];
    const edges: SceneEdge[] = [
      { id: "e1", from: "A", to: "M" },
      { id: "e2", from: "M", to: "B" },
    ];
    const bridges = computeBridgeEdges(cards, edges, new Set(["M"]));
    expect(bridges).toEqual([{ id: "bridge:A>B", from: "A", to: "B" }]);
  });
  it("숨긴 노드 없으면 빈 배열", () => {
    const cards = [gen("A"), gen("B")];
    const edges: SceneEdge[] = [{ id: "e1", from: "A", to: "B" }];
    expect(computeBridgeEdges(cards, edges, new Set())).toEqual([]);
  });
});

describe("classifyEdges", () => {
  it("레퍼런스 카드 → 생성 = refCardEdge(파란 점선)", () => {
    const cards: SceneCard[] = [
      { id: "R", kind: "reference", x: 0, y: 0, refs: [] },
      gen("G"),
    ];
    const byId = new Map(cards.map((c) => [c.id, c] as const));
    const edges: SceneEdge[] = [{ id: "e", from: "R", to: "G" }];
    const { refCardEdgeIds, genRefEdgeIds } = classifyEdges(edges, byId, {});
    expect([...refCardEdgeIds]).toEqual(["e"]);
    expect(genRefEdgeIds.size).toBe(0);
  });
  it("생성물을 @소스로 쓴 엣지 = genRefEdge(초록 점선)", () => {
    const cards: SceneCard[] = [
      gen("S"),
      gen("T", { refs: [{ file_path: "x", type: "image", source_gen_id: "S" }] }),
    ];
    const byId = new Map(cards.map((c) => [c.id, c] as const));
    const edges: SceneEdge[] = [{ id: "e", from: "S", to: "T" }];
    const { genRefEdgeIds } = classifyEdges(edges, byId, {});
    expect([...genRefEdgeIds]).toEqual(["e"]);
  });
});
