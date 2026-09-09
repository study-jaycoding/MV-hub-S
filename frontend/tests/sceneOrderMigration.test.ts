// 수집기 '연결 순서' 전환의 두 축 — ① 새 연결엔 연결 시점에 order 를 매긴다(withCollectorOrder)
//  ② 기존 씬은 열 때 옛 표시 순서를 order 로 한 번 고정한다(freezeLegacyCollectorOrder). 코덱스 1·2차 리뷰 P1.
//  기존 씬은 edge.order 없이 소스 y→x 로 보였고 생성 카드 refs(@image 번호)도 그 순서로 모였다. 고정하지 않으면 표시·텍스트
//  @image 썸네일·실제 제출 refs 가 어긋난다. 새 연결에 order 가 없으면 씬 전환 effect 의 freeze 가 그것마저 y 순으로 되돌린다.
import { describe, it, expect } from "vitest";
import {
  collectListInputs,
  collectRenderGenCardIds,
  freezeLegacyCollectorOrder,
  withCollectorOrder,
} from "../src/lib/sceneEdges";
import type { SceneCard, SceneEdge } from "../src/lib/scenes";

const node = (id: string, kind: SceneCard["kind"], over: Partial<SceneCard> = {}): SceneCard => ({
  id,
  kind,
  x: 0,
  y: 0,
  ...over,
});
const byId = (cards: SceneCard[]) => new Map(cards.map((c) => [c.id, c] as const));

describe("withCollectorOrder — 새 연결의 연결 순서", () => {
  it("list·render 타깃의 새 연결에 '기존 최대 order 다음' 순번을 배열 순서대로 매긴다", () => {
    const cards = byId([node("L", "list"), node("A", "generation"), node("B", "generation"), node("C", "generation")]);
    const existing: SceneEdge[] = [{ id: "e1", from: "A", to: "L", order: 4 }];
    const added = withCollectorOrder(existing, [
      { id: "e2", from: "B", to: "L" },
      { id: "e3", from: "C", to: "L" },
    ], cards);
    expect(added.map((e) => e.order)).toEqual([5, 6]);
  });
  it("수집기가 아닌 타깃·이미 order 가 있는 연결은 그대로", () => {
    const cards = byId([node("G", "generation"), node("L", "list"), node("T", "text"), node("A", "generation")]);
    const added = withCollectorOrder([], [
      { id: "e1", from: "T", to: "G" },
      { id: "e2", from: "A", to: "L", order: 9 },
    ], cards);
    expect(added[0].order).toBeUndefined();
    expect(added[1].order).toBe(9);
  });
  it("기존 연결에 order 가 하나도 없어도(이행 전) 그 개수 뒤에 붙는다", () => {
    const cards = byId([node("L", "list"), node("A", "generation"), node("B", "generation"), node("C", "generation")]);
    const existing: SceneEdge[] = [{ id: "e1", from: "A", to: "L" }, { id: "e2", from: "B", to: "L" }];
    expect(withCollectorOrder(existing, [{ id: "e3", from: "C", to: "L" }], cards)[0].order).toBe(2);
  });
  it("새 연결에 order 가 있으면 freeze 가 y 순으로 되돌리지 않는다(코덱스 2차 P1 재현)", () => {
    const cards = [
      node("L", "list"),
      node("R1", "reference", { y: 100, refs: [] }),
      node("R2", "reference", { y: 0, refs: [] }),
    ];
    const added = withCollectorOrder([], [
      { id: "e1", from: "R1", to: "L" }, // 먼저 연결(아래쪽 카드)
      { id: "e2", from: "R2", to: "L" },
    ], byId(cards));
    const frozen = freezeLegacyCollectorOrder(cards, added);
    expect(frozen).toBe(added); // 변경 없음
    expect(collectListInputs("L", byId(cards), frozen).referenceCardIds).toEqual(["R1", "R2"]);
  });
});

describe("freezeLegacyCollectorOrder — 기존 씬 이행", () => {
  it("order 없는 리스트 연결에 옛 표시 순서(소스 y→x)를 order 로 박는다 → 이행 뒤에도 보이던 순서 그대로", () => {
    const cards = [
      node("L", "list"),
      node("R1", "reference", { y: 100, refs: [] }),
      node("R2", "reference", { y: 0, refs: [] }),
    ];
    const edges: SceneEdge[] = [
      { id: "e1", from: "R1", to: "L" }, // 먼저 연결했지만 아래(y=100)에 있어 옛 표시는 R2, R1
      { id: "e2", from: "R2", to: "L" },
    ];
    const frozen = freezeLegacyCollectorOrder(cards, edges);
    expect(frozen.map((e) => [e.id, e.order])).toEqual([["e1", 1], ["e2", 0]]);
    expect(collectListInputs("L", byId(cards), frozen).referenceCardIds).toEqual(["R2", "R1"]);
    // 이행 없이 새 규칙만 적용했다면 연결 순서(R1, R2)로 바뀌어 생성 카드 refs 와 어긋났을 것
    expect(collectListInputs("L", byId(cards), edges).referenceCardIds).toEqual(["R1", "R2"]);
  });
  it("전부 order 가 있으면 같은 배열 참조를 돌려준다(변경 없음 판정) — 두 번 돌려도 같다", () => {
    const cards = [node("L", "list"), node("G1", "generation", { y: 9 }), node("G2", "generation", { y: 1 })];
    const edges: SceneEdge[] = [
      { id: "e1", from: "G1", to: "L" },
      { id: "e2", from: "G2", to: "L" },
    ];
    const once = freezeLegacyCollectorOrder(cards, edges);
    expect(once).not.toBe(edges);
    expect(freezeLegacyCollectorOrder(cards, once)).toBe(once);
  });
  it("일부만 order 가 있으면 옛 규칙대로(order 먼저, 나머지 y) 전부에 순번을 매긴다", () => {
    const cards = [
      node("L", "list"),
      node("G1", "generation", { y: 50 }),
      node("G2", "generation", { y: 0 }),
      node("G3", "generation", { y: 20 }),
    ];
    const edges: SceneEdge[] = [
      { id: "e1", from: "G1", to: "L", order: 0 },
      { id: "e2", from: "G2", to: "L" },
      { id: "e3", from: "G3", to: "L" },
    ];
    const frozen = freezeLegacyCollectorOrder(cards, edges);
    expect(collectListInputs("L", byId(cards), frozen).generationCardIds).toEqual(["G1", "G2", "G3"]);
    expect(frozen.map((e) => e.order)).toEqual([0, 1, 2]);
  });
  it("렌더 노드도 고정한다(실행 순서 보존). 수집기가 아닌 타깃의 연결은 건드리지 않는다", () => {
    const cards = [
      node("RN", "render"),
      node("G1", "generation", { y: 100, genId: "G1", genIds: ["G1"] }),
      node("G2", "generation", { y: 0, genId: "G2", genIds: ["G2"] }),
      node("T", "text"),
      node("X", "generation", { refs: [], genId: null }),
    ];
    const edges: SceneEdge[] = [
      { id: "e1", from: "G1", to: "RN" },
      { id: "e2", from: "G2", to: "RN" },
      { id: "e3", from: "T", to: "X" },
    ];
    const frozen = freezeLegacyCollectorOrder(cards, edges);
    expect(collectRenderGenCardIds("RN", byId(cards), frozen)).toEqual(["G2", "G1"]);
    expect(frozen.find((e) => e.id === "e3")?.order).toBeUndefined();
  });
  it("고정한 뒤 새로 연결한 항목은 뒤에 붙는다(카드가 더 위에 있어도)", () => {
    const cards = [
      node("L", "list"),
      node("G1", "generation", { y: 100 }),
      node("G2", "generation", { y: 0 }),
      node("G3", "generation", { y: -50 }),
    ];
    const edges: SceneEdge[] = [
      { id: "e1", from: "G1", to: "L" },
      { id: "e2", from: "G2", to: "L" },
    ];
    const frozen = freezeLegacyCollectorOrder(cards, edges);
    const later = [...frozen, ...withCollectorOrder(frozen, [{ id: "e3", from: "G3", to: "L" }], byId(cards))];
    expect(collectListInputs("L", byId(cards), later).generationCardIds).toEqual(["G2", "G1", "G3"]);
    expect(freezeLegacyCollectorOrder(cards, later)).toBe(later); // 다음 로드에도 그대로
  });
  it("무선 input 을 거친 연결은 실제 소스의 y 로 옛 순서를 판단한다", () => {
    const cards = [
      node("L", "list"),
      node("OUT", "output", { text: "ch" }),
      node("IN", "input", { channel: "OUT" }),
      node("G1", "generation", { y: 100 }), // OUT 에 물린 실제 소스(아래)
      node("G2", "generation", { y: 0 }),
    ];
    const edges: SceneEdge[] = [
      { id: "e0", from: "G1", to: "OUT" },
      { id: "e1", from: "IN", to: "L" }, // input 카드 자체는 y=0 이지만 실제 소스 G1 은 y=100
      { id: "e2", from: "G2", to: "L" },
    ];
    const frozen = freezeLegacyCollectorOrder(cards, edges);
    expect(frozen.find((e) => e.id === "e1")?.order).toBe(1);
    expect(frozen.find((e) => e.id === "e2")?.order).toBe(0);
  });
});
