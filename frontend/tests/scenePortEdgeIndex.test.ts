// resolvePortEdges 의 '들어오는 엣지 인덱스' 도입 동등성 — 인덱스를 쓰든 매번 전체를 훑든 결과가 같아야 한다.
//  (인덱스는 원본 순서를 유지하므로 output 대표 소스 선정·중복 제거 결과가 바뀌면 안 된다.)
import { describe, expect, it } from "vitest";
import { resolveInputSourceId, resolvePortEdges } from "../src/lib/sceneEdges";
import type { SceneCard, SceneEdge } from "../src/lib/scenes";

const card = (id: string, kind: SceneCard["kind"], over: Partial<SceneCard> = {}): SceneCard => ({
  id,
  kind,
  x: 0,
  y: 0,
  ...over,
});

// 인덱스 도입 전 구현(엣지마다 edges 전체 filter) — 비교 기준.
function resolvePortEdgesNaive(
  cardsById: Map<string, SceneCard>,
  edges: SceneEdge[],
): SceneEdge[] {
  const out: SceneEdge[] = [];
  const seenPair = new Set<string>();
  for (const e of edges) {
    const from = cardsById.get(e.from);
    let realFrom = e.from;
    if (from?.kind === "input") {
      const r = resolveInputSourceId(e.from, cardsById, edges);
      if (!r) continue;
      realFrom = r;
    }
    const key = realFrom + ">" + e.to;
    if (seenPair.has(key)) continue;
    seenPair.add(key);
    out.push(realFrom === e.from ? e : { ...e, from: realFrom });
  }
  return out;
}

// 무선(input/output) · 다중 소스 · 미해석 input · 사이클 · 중복쌍을 한 그래프에 담는다.
function sampleGraph(): { cardsById: Map<string, SceneCard>; edges: SceneEdge[] } {
  const cards = [
    card("g1", "generation", { y: 30 }),
    card("g2", "generation", { y: 10 }),
    card("g3", "generation"),
    card("out1", "output"),
    card("in1", "input", { channel: "out1" }),
    card("in2", "input"), // 채널 미선택 → 해석 불가
    card("out2", "output"),
    card("in3", "input", { channel: "out2" }), // out2 ← in3 (사이클)
    card("target", "generation"),
  ];
  const edges: SceneEdge[] = [
    { id: "e1", from: "g1", to: "out1" }, // y=30
    { id: "e2", from: "g2", to: "out1", order: 5 }, // order 있음 → 대표
    { id: "e3", from: "in1", to: "target" }, // 무선 → g2 로 해석
    { id: "e4", from: "g2", to: "target" }, // 위와 같은 쌍(g2>target) → 중복 제거 대상
    { id: "e5", from: "in2", to: "target" }, // 해석 불가 → 제외
    { id: "e6", from: "in3", to: "target" }, // 사이클 → 제외
    { id: "e7", from: "in3", to: "out2" },
    { id: "e8", from: "g3", to: "target", role: "ref", order: 2 }, // 일반 엣지(필드 보존 확인)
  ];
  return { cardsById: new Map(cards.map((c) => [c.id, c])), edges };
}

describe("resolvePortEdges (incoming 인덱스)", () => {
  it("인덱스를 쓰기 전 구현과 결과가 같다", () => {
    const { cardsById, edges } = sampleGraph();
    expect(resolvePortEdges(cardsById, edges)).toEqual(resolvePortEdgesNaive(cardsById, edges));
  });

  it("무선 input 은 실제 소스로 치환하고, 같은 쌍은 한 번만 남긴다", () => {
    const { cardsById, edges } = sampleGraph();
    const out = resolvePortEdges(cardsById, edges);
    // e3 이 g2>target 을 먼저 차지하므로 e4 는 중복으로 빠진다.
    // e5(채널 미선택)·e6/e7(자기 output 을 도로 가리키는 사이클)은 해석 불가라 제외된다.
    expect(out.map((e) => `${e.id}:${e.from}>${e.to}`)).toEqual([
      "e1:g1>out1",
      "e2:g2>out1",
      "e3:g2>target",
      "e8:g3>target",
    ]);
    // 치환된 엣지도 order/role 등 원본 필드를 보존한다.
    expect(out.find((e) => e.id === "e8")).toEqual({
      id: "e8",
      from: "g3",
      to: "target",
      role: "ref",
      order: 2,
    });
  });

  it("output 대표 소스 선정(order → y → x)이 그대로다", () => {
    const { cardsById, edges } = sampleGraph();
    // order 가 붙은 g2 가 대표 — order 를 떼면 y 가 작은 g2 가 여전히 대표, y 를 뒤집으면 g1.
    expect(resolveInputSourceId("in1", cardsById, edges)).toBe("g2");
    const flipped = edges.map((e) => (e.id === "e2" ? { ...e, order: undefined } : e));
    const g1 = cardsById.get("g1") as SceneCard;
    cardsById.set("g1", { ...g1, y: 0 });
    expect(resolvePortEdges(cardsById, flipped).find((e) => e.id === "e3")?.from).toBe("g1");
  });
});
