// sceneEdges 순수 그래프/기하 특성화 — SceneBoard 엣지 렌더의 안전망(이번 리팩토링으로 추출).
import { describe, it, expect } from "vitest";
import {
  edgePathXY,
  fanOffset,
  computeBridgeEdges,
  classifyEdges,
  resolveEdgeRole,
  collectListInputs,
  collectViewGenCardIds,
  collectViewTexts,
  canConnect,
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

describe("resolveEdgeRole", () => {
  const node = (id: string, kind: SceneCard["kind"]): SceneCard => ({ id, kind, x: 0, y: 0 });
  const byId = (cards: SceneCard[]) => new Map(cards.map((c) => [c.id, c] as const));

  it("명시 role 이 있으면 그대로 반환(추론보다 우선)", () => {
    const cards = [node("A", "generation"), node("B", "generation")];
    const e: SceneEdge = { id: "e", from: "A", to: "B", role: "text" };
    expect(resolveEdgeRole(e, byId(cards), {})).toBe("text");
  });
  it("model 노드 소스 → 'model'", () => {
    const cards = [node("M", "model"), node("G", "generation")];
    const e: SceneEdge = { id: "e", from: "M", to: "G" };
    expect(resolveEdgeRole(e, byId(cards), {})).toBe("model");
  });
  it("text 노드 소스 → 'text'", () => {
    const cards = [node("T", "text"), node("G", "generation")];
    const e: SceneEdge = { id: "e", from: "T", to: "G" };
    expect(resolveEdgeRole(e, byId(cards), {})).toBe("text");
  });
  it("reference 카드 소스 → 'ref'", () => {
    const cards = [node("R", "reference"), node("G", "generation")];
    const e: SceneEdge = { id: "e", from: "R", to: "G" };
    expect(resolveEdgeRole(e, byId(cards), {})).toBe("ref");
  });
  it("생성물 → list = 'list', 텍스트 → list = 'text'(소스색 우선=보라)", () => {
    const cards = [node("G", "generation"), node("T", "text"), node("L", "list")];
    expect(resolveEdgeRole({ id: "e1", from: "G", to: "L" }, byId(cards), {})).toBe("list");
    expect(resolveEdgeRole({ id: "e2", from: "T", to: "L" }, byId(cards), {})).toBe("text");
  });
  it("생성물을 ref 로 사용한 gen→gen → 'ref', 아니면 'lineage'", () => {
    const S = gen("S");
    const T = gen("T", { refs: [{ file_path: "x", type: "image", source_gen_id: "S" }] });
    const U = gen("U");
    const cards = byId([S, T, U]);
    expect(resolveEdgeRole({ id: "e1", from: "S", to: "T" }, cards, {})).toBe("ref");
    expect(resolveEdgeRole({ id: "e2", from: "S", to: "U" }, cards, {})).toBe("lineage");
  });
});

describe("collectListInputs", () => {
  const node = (id: string, kind: SceneCard["kind"], over: Partial<SceneCard> = {}): SceneCard => ({
    id,
    kind,
    x: 0,
    y: 0,
    ...over,
  });
  const byId = (cards: SceneCard[]) => new Map(cards.map((c) => [c.id, c] as const));

  it("입력 없으면 empty", () => {
    expect(collectListInputs("L", byId([node("L", "list")]), []).kind).toBe("empty");
  });
  it("생성카드만 → generation, 순서=소스 y", () => {
    const cards = byId([
      node("L", "list"),
      node("G2", "generation", { y: 20 }),
      node("G1", "generation", { y: 5 }),
    ]);
    const edges: SceneEdge[] = [
      { id: "e1", from: "G2", to: "L" },
      { id: "e2", from: "G1", to: "L" },
    ];
    const r = collectListInputs("L", cards, edges);
    expect(r.kind).toBe("generation");
    expect(r.generationCardIds).toEqual(["G1", "G2"]); // y 오름차순
  });
  it("edge.order 가 y 보다 우선", () => {
    const cards = byId([
      node("L", "list"),
      node("G1", "generation", { y: 5 }),
      node("G2", "generation", { y: 20 }),
    ]);
    const edges: SceneEdge[] = [
      { id: "e1", from: "G1", to: "L", order: 2 },
      { id: "e2", from: "G2", to: "L", order: 1 },
    ];
    expect(collectListInputs("L", cards, edges).generationCardIds).toEqual(["G2", "G1"]);
  });
  it("텍스트만 → text, join('\\n')", () => {
    const cards = byId([
      node("L", "list"),
      node("T1", "text", { y: 0, text: "hello" }),
      node("T2", "text", { y: 10, text: "world" }),
    ]);
    const edges: SceneEdge[] = [
      { id: "e1", from: "T1", to: "L" },
      { id: "e2", from: "T2", to: "L" },
    ];
    const r = collectListInputs("L", cards, edges);
    expect(r.kind).toBe("text");
    expect(r.text).toBe("hello\nworld");
  });
  it("gen+text 혼합 → mixed, model 섞이면 invalid", () => {
    const cards = byId([
      node("L", "list"),
      node("G", "generation"),
      node("T", "text"),
      node("M", "model"),
    ]);
    expect(
      collectListInputs("L", cards, [
        { id: "e1", from: "G", to: "L" },
        { id: "e2", from: "T", to: "L" },
      ]).kind,
    ).toBe("mixed");
    expect(
      collectListInputs("L", cards, [
        { id: "e1", from: "G", to: "L" },
        { id: "e2", from: "M", to: "L" },
      ]).kind,
    ).toBe("invalid");
  });
});

describe("collectViewGenCardIds", () => {
  const node = (id: string, kind: SceneCard["kind"], over: Partial<SceneCard> = {}): SceneCard => ({
    id,
    kind,
    x: 0,
    y: 0,
    ...over,
  });
  const byId = (cards: SceneCard[]) => new Map(cards.map((c) => [c.id, c] as const));

  it("생성카드 직접 + generation-list 를 펼쳐 수집(중복 제거)", () => {
    const cards = byId([
      node("V", "view"),
      node("G1", "generation", { y: 0 }),
      node("L", "list", { y: 10 }),
      node("G2", "generation", { y: 100 }),
      node("G3", "generation", { y: 200 }),
    ]);
    const edges: SceneEdge[] = [
      { id: "e1", from: "G1", to: "V" }, // 직접
      { id: "e2", from: "L", to: "V" }, // 리스트 경유
      { id: "e3", from: "G2", to: "L" },
      { id: "e4", from: "G3", to: "L" },
    ];
    expect(collectViewGenCardIds("V", cards, edges)).toEqual(["G1", "G2", "G3"]);
  });
  it("text-list 는 미디어 수집에서 무시(collectViewGenCardIds 는 생성물만)", () => {
    const cards = byId([
      node("V", "view"),
      node("L", "list"),
      node("T", "text", { text: "x" }),
    ]);
    const edges: SceneEdge[] = [
      { id: "e1", from: "L", to: "V" },
      { id: "e2", from: "T", to: "L" },
    ];
    expect(collectViewGenCardIds("V", cards, edges)).toEqual([]);
  });
});

describe("collectViewTexts", () => {
  const node = (id: string, kind: SceneCard["kind"], over: Partial<SceneCard> = {}): SceneCard => ({
    id,
    kind,
    x: 0,
    y: 0,
    ...over,
  });
  const byId = (cards: SceneCard[]) => new Map(cards.map((c) => [c.id, c] as const));

  it("text 직접 연결 + text-list 를 순서대로 수집", () => {
    const cards = byId([
      node("V", "view"),
      node("T1", "text", { y: 0, text: "hello" }),
      node("L", "list", { y: 10 }),
      node("T2", "text", { y: 100, text: "a" }),
      node("T3", "text", { y: 200, text: "b" }),
    ]);
    const edges: SceneEdge[] = [
      { id: "e1", from: "T1", to: "V" },
      { id: "e2", from: "L", to: "V" },
      { id: "e3", from: "T2", to: "L" },
      { id: "e4", from: "T3", to: "L" },
    ];
    expect(collectViewTexts("V", cards, edges)).toEqual(["hello", "a\nb"]);
  });
  it("생성물/빈 텍스트는 제외", () => {
    const cards = byId([node("V", "view"), node("G", "generation"), node("T", "text", { text: "  " })]);
    const edges: SceneEdge[] = [
      { id: "e1", from: "G", to: "V" },
      { id: "e2", from: "T", to: "V" },
    ];
    expect(collectViewTexts("V", cards, edges)).toEqual([]);
  });
});

describe("canConnect", () => {
  const c = (id: string, kind: SceneCard["kind"]): SceneCard => ({ id, kind, x: 0, y: 0 });
  it("generation 은 view 외 모든 소스 허용", () => {
    const G = c("G", "generation");
    expect(canConnect(c("M", "model"), G)).toBe(true);
    expect(canConnect(c("T", "text"), G)).toBe(true);
    expect(canConnect(c("R", "reference"), G)).toBe(true);
    expect(canConnect(c("L", "list"), G)).toBe(true);
    expect(canConnect(c("V", "view"), G)).toBe(false);
  });
  it("list 는 generation/text 만", () => {
    const L = c("L", "list");
    expect(canConnect(c("G", "generation"), L)).toBe(true);
    expect(canConnect(c("T", "text"), L)).toBe(true);
    expect(canConnect(c("M", "model"), L)).toBe(false);
  });
  it("view 는 generation/list/text (미디어+텍스트 뷰어)", () => {
    const V = c("V", "view");
    expect(canConnect(c("G", "generation"), V)).toBe(true);
    expect(canConnect(c("L", "list"), V)).toBe(true);
    expect(canConnect(c("T", "text"), V)).toBe(true);
    expect(canConnect(c("M", "model"), V)).toBe(false);
  });
  it("text/model/reference 는 입력 없음, 자기연결 금지", () => {
    expect(canConnect(c("A", "generation"), c("B", "text"))).toBe(false);
    expect(canConnect(c("A", "generation"), c("B", "model"))).toBe(false);
    expect(canConnect(c("X", "generation"), c("X", "generation"))).toBe(false);
  });
});
