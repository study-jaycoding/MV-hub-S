// sceneEdges 순수 그래프/기하 특성화 — SceneBoard 엣지 렌더의 안전망(이번 리팩토링으로 추출).
import { describe, it, expect, vi } from "vitest";
import {
  edgePathXY,
  fanOffset,
  computeBridgeEdges,
  classifyEdges,
  resolveEdgeRole,
  resolveEdgeRoles,
  collectListInputs,
  collectRenderGenCardIds,
  collectViewGenCardIds,
  collectViewTexts,
  collectGenText,
  collectGenModel,
  collectGenRefs,
  comfyDeclaredKinds,
  comfyTextDriveKeys,
  comfyGenMeta,
  canConnect,
  resolveInputSourceId,
  resolvePortEdges,
  buildGenerationExecutionPlan,
  buildRenderExecutionPlan,
  isGenerationExecutionPlanCurrent,
  isRenderExecutionPlanCurrent,
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
  it("set 노드 소스 → 생성 카드의 text 레인", () => {
    const cards = [node("S", "set"), node("G", "generation")];
    const e: SceneEdge = { id: "e", from: "S", to: "G" };
    expect(canConnect(cards[0], cards[1])).toBe(true);
    expect(canConnect(cards[0], node("L", "list"))).toBe(false);
    expect(resolveEdgeRole(e, byId(cards), {})).toBe("text");
  });
  it("reference 카드 소스 → 'ref'", () => {
    const cards = [node("R", "reference"), node("G", "generation")];
    const e: SceneEdge = { id: "e", from: "R", to: "G" };
    expect(resolveEdgeRole(e, byId(cards), {})).toBe("ref");
  });
  it("출력을 저장한 comfy(genIds 보유) 소스 → 'lineage'(생성물색)", () => {
    const savedComfy: SceneCard = { id: "CF", kind: "comfy", x: 0, y: 0, genId: "g", genIds: ["g"] };
    const cards = byId([savedComfy, node("G", "generation")]);
    expect(resolveEdgeRole({ id: "e", from: "CF", to: "G" }, cards, {})).toBe("lineage");
  });
  it("생성물 → list = 'list', 텍스트 → list = 'text'(소스색 우선=보라)", () => {
    const cards = [node("G", "generation"), node("T", "text"), node("L", "list")];
    expect(resolveEdgeRole({ id: "e1", from: "G", to: "L" }, byId(cards), {})).toBe("list");
    expect(resolveEdgeRole({ id: "e2", from: "T", to: "L" }, byId(cards), {})).toBe("text");
  });
  it("리스트 → 텍스트 노드 = 'ref'(텍스트 노드 입력은 무엇이든 레퍼런스/파랑)", () => {
    const cards = [node("L", "list"), node("T", "text")];
    expect(resolveEdgeRole({ id: "e", from: "L", to: "T" }, byId(cards), {})).toBe("ref");
  });
  it("텍스트 수집 리스트의 출력 → 생성카드 = 'text'(edges 전달 시), 생성물 리스트면 'lineage'", () => {
    const textList = byId([node("L", "list"), node("T", "text"), node("G", "generation")]);
    const te: SceneEdge[] = [
      { id: "e1", from: "T", to: "L" },
      { id: "e2", from: "L", to: "G" },
    ];
    expect(resolveEdgeRole(te[1], textList, {}, te)).toBe("text");
    const genList = byId([node("L", "list"), node("S", "generation"), node("G", "generation")]);
    const ge: SceneEdge[] = [
      { id: "e1", from: "S", to: "L" },
      { id: "e2", from: "L", to: "G" },
    ];
    // 생성물(미디어) 리스트 → 생성카드 = 레퍼런스(파랑). 커밋 f0e10f7 이후 lineage→ref 로 정정.
    expect(resolveEdgeRole(ge[1], genList, {}, ge)).toBe("ref");
  });
  it("생성물을 ref 로 사용한 gen→gen → 'ref', 아니면 'lineage'", () => {
    const S = gen("S");
    const T = gen("T", { refs: [{ file_path: "x", type: "image", source_gen_id: "S" }] });
    const U = gen("U");
    const cards = byId([S, T, U]);
    expect(resolveEdgeRole({ id: "e1", from: "S", to: "T" }, cards, {})).toBe("ref");
    expect(resolveEdgeRole({ id: "e2", from: "S", to: "U" }, cards, {})).toBe("lineage");
  });

  it("일괄 역할 판정은 input/list를 인덱스로 해석하고 단일 판정 결과와 같다", () => {
    const cards = byId([
      node("M", "model"),
      node("O", "output"),
      { ...node("I", "input"), channel: "O" },
      node("G1", "generation"),
      node("G2", "generation"),
      { ...node("T", "text"), text: "prompt" },
      node("L", "list"),
      node("R", "reference"),
    ]);
    const edges: SceneEdge[] = [
      { id: "model-output", from: "M", to: "O" },
      { id: "input-gen", from: "I", to: "G1" },
      { id: "text-list", from: "T", to: "L" },
      { id: "list-gen", from: "L", to: "G2" },
      { id: "ref-gen", from: "R", to: "G2" },
    ];
    const expected = new Map(edges.map((edge) => [edge.id, resolveEdgeRole(edge, cards, {}, edges)]));
    // 일괄 경로가 원본 edges.filter를 다시 호출하면 즉시 실패한다. 내부의 작은 임시 배열 filter는 허용한다.
    const guardedEdges = new Proxy(edges, {
      get(target, property, receiver) {
        if (property === "filter") throw new Error("전체 엣지 재탐색");
        return Reflect.get(target, property, receiver);
      },
    });

    expect(resolveEdgeRoles(guardedEdges, cards, {})).toEqual(expected);
    expect(expected.get("input-gen")).toBe("model");
    expect(expected.get("list-gen")).toBe("text");
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
  it("중첩: 리스트가 렌더를 받으면 렌더 안 생성카드들을 순서대로 펼친다", () => {
    const cards = byId([
      node("L", "list"),
      node("R", "render"),
      node("GA", "generation"),
      node("GB", "generation"),
    ]);
    const edges: SceneEdge[] = [
      { id: "e1", from: "GA", to: "R", order: 1 },
      { id: "e2", from: "GB", to: "R", order: 2 },
      { id: "e3", from: "R", to: "L" },
    ];
    const r = collectListInputs("L", cards, edges);
    expect(r.kind).toBe("generation");
    expect(r.generationCardIds).toEqual(["GA", "GB"]); // 렌더 안 2개 카드 모두 펼침
    expect(r.sourceIds).toEqual(["R"]); // 직접 소스는 렌더 1개(행표시·reorder 기준)
  });
  it("중첩: 리스트가 다른 생성 리스트를 받으면 그 안 카드들을 펼친다(+직접 소스)", () => {
    const cards = byId([
      node("OUT", "list"),
      node("IN", "list"),
      node("GA", "generation"),
      node("GB", "generation"),
      node("GC", "generation"),
    ]);
    const edges: SceneEdge[] = [
      { id: "e1", from: "GA", to: "IN", order: 1 },
      { id: "e2", from: "GB", to: "IN", order: 2 },
      { id: "e3", from: "IN", to: "OUT", order: 1 },
      { id: "e4", from: "GC", to: "OUT", order: 2 },
    ];
    const r = collectListInputs("OUT", cards, edges);
    expect(r.kind).toBe("generation");
    expect(r.generationCardIds).toEqual(["GA", "GB", "GC"]);
  });
  it("중첩: 리스트 순환(A→B→A)이어도 무한재귀 없이 판정(invalid)", () => {
    const cards = byId([node("A", "list"), node("B", "list"), node("G", "generation")]);
    const edges: SceneEdge[] = [
      { id: "e1", from: "B", to: "A" },
      { id: "e2", from: "A", to: "B" }, // 순환
      { id: "e3", from: "G", to: "A" },
    ];
    expect(collectListInputs("A", cards, edges).kind).toBe("invalid"); // 순환 소스는 무시(other)
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
  it("render 노드도 리스트처럼 그 안의 생성 카드들을 펼쳐 View 로 넘긴다", () => {
    const cards = byId([
      node("V", "view"),
      node("RN", "render"),
      node("G1", "generation", { y: 0 }),
      node("G2", "generation", { y: 100 }),
    ]);
    const edges: SceneEdge[] = [
      { id: "e1", from: "RN", to: "V" }, // render → view
      { id: "e2", from: "G1", to: "RN" },
      { id: "e3", from: "G2", to: "RN" },
    ];
    expect(collectViewGenCardIds("V", cards, edges)).toEqual(["G1", "G2"]);
  });
});

describe("collectRenderGenCardIds", () => {
  const node = (id: string, kind: SceneCard["kind"], over: Partial<SceneCard> = {}): SceneCard => ({
    id,
    kind,
    x: 0,
    y: 0,
    ...over,
  });
  const byId = (cards: SceneCard[]) => new Map(cards.map((c) => [c.id, c] as const));

  it("연결된 생성 카드만 y→x 순으로(생성 외 소스는 무시)", () => {
    const cards = byId([
      node("RN", "render"),
      node("G2", "generation", { y: 100 }),
      node("G1", "generation", { y: 0 }),
      node("T", "text", { y: 50, text: "x" }),
      node("L", "list", { y: 60 }),
    ]);
    const edges: SceneEdge[] = [
      { id: "e1", from: "G2", to: "RN" },
      { id: "e2", from: "G1", to: "RN" },
      { id: "e3", from: "T", to: "RN" }, // 텍스트는 canConnect 에서 막히지만, 수집 함수도 생성만 남긴다
      { id: "e4", from: "L", to: "RN" },
    ];
    expect(collectRenderGenCardIds("RN", cards, edges)).toEqual(["G1", "G2"]);
  });
  it("연결 없으면 빈 배열", () => {
    expect(collectRenderGenCardIds("RN", byId([node("RN", "render")]), [])).toEqual([]);
  });
  it("출력을 저장한 comfy(genIds 보유)도 생성물로 수집 — 생성카드와 함께 렌더에 쌓임", () => {
    const cards = byId([
      node("RN", "render"),
      node("G1", "generation", { y: 0, genId: "G1", genIds: ["G1"] }),
      node("CF", "comfy", { y: 50, genId: "cf-gen", genIds: ["cf-gen"] }), // 저장된 comfy
      node("CF0", "comfy", { y: 60 }), // 아직 출력 없음 → 수집 제외
    ]);
    const edges: SceneEdge[] = [
      { id: "e1", from: "G1", to: "RN" },
      { id: "e2", from: "CF", to: "RN" },
      { id: "e3", from: "CF0", to: "RN" },
    ];
    expect(collectRenderGenCardIds("RN", cards, edges)).toEqual(["G1", "CF"]);
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

describe("collectGenText / collectGenModel", () => {
  const node = (id: string, kind: SceneCard["kind"], over: Partial<SceneCard> = {}): SceneCard => ({
    id,
    kind,
    x: 0,
    y: 0,
    ...over,
  });
  const byId = (cards: SceneCard[]) => new Map(cards.map((c) => [c.id, c] as const));

  it("연결된 text 노드 + text-list 를 순서로 합침(count)", () => {
    const cards = byId([
      node("G", "generation"),
      node("T1", "text", { y: 0, text: "hello" }),
      node("L", "list", { y: 50 }),
      node("T2", "text", { y: 100, text: "a" }),
      node("T3", "text", { y: 200, text: "b" }),
    ]);
    const edges: SceneEdge[] = [
      { id: "e1", from: "T1", to: "G" },
      { id: "e2", from: "L", to: "G" },
      { id: "e3", from: "T2", to: "L" },
      { id: "e4", from: "T3", to: "L" },
    ];
    const r = collectGenText("G", cards, edges);
    expect(r.count).toBe(2);
    expect(r.text).toBe("hello\na\nb");
  });
  it("텍스트 연결 없으면 count 0", () => {
    const cards = byId([node("G", "generation"), node("R", "reference")]);
    expect(collectGenText("G", cards, [{ id: "e", from: "R", to: "G" }]).count).toBe(0);
  });
  it("collectGenModel: 모델 1개만 유효, 복수/0 이면 null", () => {
    const cards = byId([
      node("G", "generation"),
      node("M1", "model", { modelCfg: { model: "seedance_2_0_mini", type: "video" } }),
      node("M2", "model", { modelCfg: { model: "nano_banana_flash" } }),
    ]);
    expect(collectGenModel("G", cards, [{ id: "e", from: "M1", to: "G" }])?.model).toBe("seedance_2_0_mini");
    expect(
      collectGenModel("G", cards, [
        { id: "e1", from: "M1", to: "G" },
        { id: "e2", from: "M2", to: "G" },
      ]),
    ).toBeNull();
    expect(collectGenModel("G", cards, [])).toBeNull();
  });
});

describe("collectGenRefs (comfy 미디어 → 생성 ref)", () => {
  const node = (id: string, kind: SceneCard["kind"], over: Partial<SceneCard> = {}): SceneCard => ({
    id,
    kind,
    x: 0,
    y: 0,
    ...over,
  });
  const byId = (cards: SceneCard[]) => new Map(cards.map((c) => [c.id, c] as const));

  it("comfy 이미지 출력을 ref 로 수집(url·type 보존)", () => {
    const cards = byId([
      node("G", "generation"),
      node("C", "comfy", { comfyCfg: { outputs: [{ kind: "image", url: "/media/a.png" }] } }),
    ]);
    const r = collectGenRefs("G", cards, [{ id: "e", from: "C", to: "G" }]);
    expect(r).toEqual([
      { file_path: "/media/a.png", type: "image", name: "Comfy", thumb: "/media/a.png", source_gen_id: null },
    ]);
  });

  it("comfy 영상 출력은 thumb null", () => {
    const cards = byId([
      node("G", "generation"),
      node("C", "comfy", { comfyCfg: { name: "vid", outputs: [{ kind: "video", url: "/media/v.mp4" }] } }),
    ]);
    const r = collectGenRefs("G", cards, [{ id: "e", from: "C", to: "G" }]);
    expect(r[0]).toMatchObject({ file_path: "/media/v.mp4", type: "video", thumb: null, name: "vid" });
  });

  it("텍스트 출력만 있으면 ref 수집 안 함(프롬프트로만 감)", () => {
    const cards = byId([
      node("G", "generation"),
      node("C", "comfy", { comfyCfg: { outputs: [{ kind: "text", text: "hi" }] } }),
    ]);
    expect(collectGenRefs("G", cards, [{ id: "e", from: "C", to: "G" }])).toEqual([]);
  });

  it("여러 comfy 는 y→x 순으로 미디어 수집", () => {
    const cards = byId([
      node("G", "generation"),
      node("C2", "comfy", { y: 100, comfyCfg: { outputs: [{ kind: "image", url: "/media/2.png" }] } }),
      node("C1", "comfy", { y: 0, comfyCfg: { outputs: [{ kind: "image", url: "/media/1.png" }] } }),
    ]);
    const r = collectGenRefs("G", cards, [
      { id: "e1", from: "C2", to: "G" },
      { id: "e2", from: "C1", to: "G" },
    ]);
    expect(r.map((x) => x.file_path)).toEqual(["/media/1.png", "/media/2.png"]);
  });

  it("resolveEdgeRole: comfy 미디어 출력→생성은 ref(파랑), 텍스트만이면 text(보라)", () => {
    const media = byId([
      node("G", "generation"),
      node("C", "comfy", { comfyCfg: { outputs: [{ kind: "image", url: "/media/a.png" }] } }),
    ]);
    expect(resolveEdgeRole({ id: "e", from: "C", to: "G" }, media, {})).toBe("ref");
    const text = byId([
      node("G", "generation"),
      node("C", "comfy", { comfyCfg: { outputs: [{ kind: "text", text: "hi" }] } }),
    ]);
    expect(resolveEdgeRole({ id: "e", from: "C", to: "G" }, text, {})).toBe("text");
  });

  it("resolveEdgeRole: comfy→text 는 미디어 출력이어도 text(보라) 유지", () => {
    const cards = byId([
      node("T", "text"),
      node("C", "comfy", { comfyCfg: { outputs: [{ kind: "image", url: "/media/a.png" }] } }),
    ]);
    expect(resolveEdgeRole({ id: "e", from: "C", to: "T" }, cards, {})).toBe("text");
  });

  // ★워크플로우 선언 기준: SaveText 워크플로우면 옛(stale) 미디어 출력이 남아 있어도 text 레인으로.
  it("comfyDeclaredKinds: Save 노드 class_type 으로 출력 종류 판정", () => {
    expect(comfyDeclaredKinds('{"1":{"class_type":"SaveText|pysssss"}}')).toEqual({ media: false, text: true });
    expect(comfyDeclaredKinds('{"2":{"class_type":"SaveImage"}}')).toEqual({ media: true, text: false });
    expect(comfyDeclaredKinds('{"3":{"class_type":"VHS_VideoCombine"}}')).toEqual({ media: true, text: false });
    expect(comfyDeclaredKinds('{"1":{"class_type":"SaveText"},"2":{"class_type":"SaveImage"}}'))
      .toEqual({ media: true, text: true });
    expect(comfyDeclaredKinds("not json")).toEqual({ media: false, text: false });
    expect(comfyDeclaredKinds(undefined)).toEqual({ media: false, text: false });
    // ★r2v: 비디오를 '입력'(VHS_LoadVideo)받고 텍스트를 '출력'(SaveText) → media 아님, text 만.
    expect(
      comfyDeclaredKinds('{"1":{"class_type":"VHS_LoadVideo"},"2":{"class_type":"SaveText|pysssss"}}'),
    ).toEqual({ media: false, text: true });
  });

  // ★연결 텍스트는 '텍스트 입력 노드'의 필드에만 주입 — model·resolution 등 설정 문자열은 제외.
  it("comfyTextDriveKeys: 텍스트 입력 노드 필드만 선별(class_type 기준)", () => {
    const content = JSON.stringify({
      "1": { class_type: "Text Multiline", inputs: { text: "" } },
      "2": { class_type: "Nano Banana Pro", inputs: { model: "gemini-3-pro", resolution: "1K" } },
      "3": { class_type: "SaveImage", inputs: { filename_prefix: "ComfyUI" } },
    });
    const params = [
      { key: "1|text", type: "text" },
      { key: "2|model", type: "text" },
      { key: "2|resolution", type: "text" },
      { key: "3|filename_prefix", type: "text" },
    ];
    // Text Multiline 의 text 만 — model·resolution·filename_prefix 는 문자열이어도 설정값이라 제외.
    expect([...comfyTextDriveKeys(params, content)]).toEqual(["1|text"]);
  });

  it("comfyTextDriveKeys: CLIPTextEncode 도 텍스트 입력으로 인식, number/bool 은 무시", () => {
    const content = JSON.stringify({
      "5": { class_type: "CLIPTextEncode", inputs: { text: "" } },
      "6": { class_type: "KSampler", inputs: { seed: 42 } },
    });
    const params = [
      { key: "5|text", type: "text" },
      { key: "6|seed", type: "number" },
    ];
    expect([...comfyTextDriveKeys(params, content)]).toEqual(["5|text"]);
  });

  it("comfyTextDriveKeys: 텍스트 노드여도 설정 필드(filename_prefix)엔 주입 안 함", () => {
    // SaveText 는 class 에 'text' 가 있어 노드 매칭되지만, filename_prefix 는 텍스트 필드가 아니므로 제외.
    const content = JSON.stringify({
      "1": { class_type: "SaveText|pysssss", inputs: { text: "", filename_prefix: "out" } },
    });
    const params = [
      { key: "1|text", type: "text" },
      { key: "1|filename_prefix", type: "text" },
    ];
    expect([...comfyTextDriveKeys(params, content)]).toEqual(["1|text"]);
  });

  it("comfyTextDriveKeys: content 없거나 깨지면 필드명으로 폴백(text/prompt 만)", () => {
    const params = [
      { key: "1|text", type: "text" },
      { key: "2|model", type: "text" },
      { key: "3|prompt", type: "text" },
    ];
    expect([...comfyTextDriveKeys(params, undefined)]).toEqual(["1|text", "3|prompt"]);
    expect([...comfyTextDriveKeys(params, "not json")]).toEqual(["1|text", "3|prompt"]);
    expect([...comfyTextDriveKeys(undefined, undefined)]).toEqual([]);
  });

  it("동일 워크플로는 출력·텍스트필드·메타 조회에서 한 번만 파싱한다", () => {
    const content =
      '{"cache-text":{"class_type":"Text Multiline","inputs":{"prompt":""}},' +
      '"cache-save":{"class_type":"SaveImage","inputs":{"model":"cache-model"}}}';
    const params = [{ key: "cache-text|prompt", type: "text" }];
    const parse = vi.spyOn(JSON, "parse");
    try {
      expect(comfyDeclaredKinds(content)).toEqual({ media: true, text: false });
      const firstKeys = comfyTextDriveKeys(params, content);
      expect([...firstKeys]).toEqual(["cache-text|prompt"]);
      expect(comfyTextDriveKeys(params, content)).toBe(firstKeys);
      expect(comfyGenMeta(content, params, {})).toEqual({ model: "cache-model" });
      expect(parse).toHaveBeenCalledTimes(1);
    } finally {
      parse.mockRestore();
    }
  });

  // ★생성 정보에 담을 model·비율·해상도 — 워크플로 baked 값 + 노출·조절값(우선) 병합.
  it("comfyGenMeta: baked 값 읽고 조절값으로 덮어씀", () => {
    const content = JSON.stringify({
      "1": { class_type: "GeminiImage2Node",
             inputs: { model: "gemini-3-pro-image-preview", aspect_ratio: "auto", resolution: "1K", seed: 42 } },
    });
    // 사용자가 resolution 을 2K 로 조절(노출) → baked "1K" 를 덮는다.
    expect(comfyGenMeta(content, [{ key: "1|resolution", type: "text" }], { "1|resolution": "2K" }))
      .toEqual({ model: "gemini-3-pro-image-preview", aspect_ratio: "auto", resolution: "2K" });
  });

  it("comfyGenMeta: content 없으면 노출값만 · malformed 안전", () => {
    expect(comfyGenMeta(undefined, [{ key: "1|model", type: "text" }], { "1|model": "x" }))
      .toEqual({ model: "x" });
    expect(comfyGenMeta("not json", undefined, undefined)).toEqual({});
    expect(comfyGenMeta(undefined, undefined, undefined)).toEqual({});
  });

  it("resolveEdgeRole: SaveText 워크플로우+stale 미디어출력이어도 생성으로는 text(선언 우선)", () => {
    const cards = byId([
      node("G", "generation"),
      node("C", "comfy", {
        comfyCfg: {
          content: '{"9":{"class_type":"SaveText|pysssss"}}', // 텍스트 전용 선언
          outputs: [{ kind: "image", url: "/media/stale.png" }], // 이전 워크플로우의 stale 미디어
        },
      }),
    ]);
    expect(resolveEdgeRole({ id: "e", from: "C", to: "G" }, cards, {})).toBe("text");
  });

  it("collectGenRefs: SaveText 워크플로우면 stale 미디어를 ref 로 붙이지 않는다", () => {
    const cards = byId([
      node("G", "generation"),
      node("C", "comfy", {
        comfyCfg: {
          content: '{"9":{"class_type":"SaveText"}}',
          outputs: [{ kind: "image", url: "/media/stale.png" }],
        },
      }),
    ]);
    expect(collectGenRefs("G", cards, [{ id: "e", from: "C", to: "G" }])).toEqual([]);
  });

  // 배치 짝 실행: overlay 가 있으면 그 복사본의 comfy 결과를 쓰고 카드 저장분은 무시(fallback 금지).
  it("overlay 우선: collectGenRefs 는 카드 슬롯 대신 overlay 미디어를 쓴다", () => {
    const cards = byId([
      node("G", "generation"),
      node("C", "comfy", { comfyCfg: { outputs: [{ kind: "image", url: "/media/card.png" }] } }),
    ]);
    const edges: SceneEdge[] = [{ id: "e", from: "C", to: "G" }];
    const overlay = { C: [{ kind: "image" as const, url: "/o/copy1.png" }] };
    expect(collectGenRefs("G", cards, edges, overlay).map((r) => r.file_path)).toEqual(["/o/copy1.png"]);
    // overlay 미제공(표시 경로)이면 카드 슬롯 사용
    expect(collectGenRefs("G", cards, edges).map((r) => r.file_path)).toEqual(["/media/card.png"]);
  });

  it("overlay 에 없는 comfy 는 카드 슬롯으로 fallback 하지 않는다(stale 방지)", () => {
    const cards = byId([
      node("G", "generation"),
      node("C", "comfy", { comfyCfg: { outputs: [{ kind: "image", url: "/media/old.png" }] } }),
    ]);
    const edges: SceneEdge[] = [{ id: "e", from: "C", to: "G" }];
    // overlay 는 주어졌지만 C 실행 결과가 없음(실패한 복사본) → 빈 배열(옛 출력으로 생성 금지)
    expect(collectGenRefs("G", cards, edges, {})).toEqual([]);
  });

  it("overlay 우선: collectGenText 는 overlay 의 comfy 텍스트를 프롬프트로 쓴다", () => {
    const cards = byId([
      node("G", "generation"),
      node("C", "comfy", { comfyCfg: { outputs: [{ kind: "text", text: "card-text" }] } }),
    ]);
    const edges: SceneEdge[] = [{ id: "e", from: "C", to: "G" }];
    const overlay = { C: [{ kind: "text" as const, text: "copy-text" }] };
    expect(collectGenText("G", cards, edges, overlay).text).toBe("copy-text");
    expect(collectGenText("G", cards, edges).text).toBe("card-text");
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
  it("render 입력은 generation 만, 출력은 미리보기(View)에만", () => {
    const R = c("R", "render");
    expect(canConnect(c("G", "generation"), R)).toBe(true);
    expect(canConnect(c("L", "list"), R)).toBe(false);
    expect(canConnect(c("T", "text"), R)).toBe(false);
    expect(canConnect(c("M", "model"), R)).toBe(false);
    // render 출력: View 재생 · 생성카드 레퍼런스(커밋 0182213) · 리스트로 중첩 수집(커밋 cd0755a).
    expect(canConnect(c("R", "render"), c("V", "view"))).toBe(true);
    expect(canConnect(c("R", "render"), c("G", "generation"))).toBe(true);
    expect(canConnect(c("R", "render"), c("L", "list"))).toBe(true);
  });
  it("text 는 reference/generation/list 입력(레퍼런스), model/text/reference 는 입력 없음, 자기연결 금지", () => {
    expect(canConnect(c("R", "reference"), c("T", "text"))).toBe(true);
    expect(canConnect(c("G", "generation"), c("T", "text"))).toBe(true);
    expect(canConnect(c("L", "list"), c("T", "text"))).toBe(true); // 리스트로 묶은 레퍼런스도 텍스트에 연결
    expect(canConnect(c("T2", "text"), c("T", "text"))).toBe(false);
    expect(canConnect(c("M", "model"), c("T", "text"))).toBe(false);
    expect(canConnect(c("A", "generation"), c("B", "model"))).toBe(false);
    expect(canConnect(c("X", "generation"), c("X", "generation"))).toBe(false);
  });
});

describe("리스트 레퍼런스 수집", () => {
  const n = (id: string, kind: SceneCard["kind"], over: Partial<SceneCard> = {}): SceneCard => ({
    id,
    kind,
    x: 0,
    y: 0,
    ...over,
  });
  const byId = (cards: SceneCard[]) => new Map(cards.map((c) => [c.id, c] as const));

  it("레퍼런스 카드만 모으면 kind=reference, sourceIds=레퍼런스 카드들(순서)", () => {
    const cards = [
      n("L", "list"),
      n("R1", "reference", { y: 0, refs: [{ file_path: "a", type: "image" }] }),
      n("R2", "reference", { y: 10, refs: [{ file_path: "b", type: "image" }] }),
    ];
    const edges: SceneEdge[] = [
      { id: "e1", from: "R1", to: "L" },
      { id: "e2", from: "R2", to: "L" },
    ];
    const li = collectListInputs("L", byId(cards), edges);
    expect(li.kind).toBe("reference");
    expect(li.sourceIds).toEqual(["R1", "R2"]);
  });
  it("레퍼런스+생성 혼합은 invalid(동종만)", () => {
    const cards = [n("L", "list"), n("R", "reference", { refs: [] }), n("G", "generation")];
    const edges: SceneEdge[] = [
      { id: "e1", from: "R", to: "L" },
      { id: "e2", from: "G", to: "L" },
    ];
    expect(collectListInputs("L", byId(cards), edges).kind).toBe("invalid");
  });
  it("canConnect: 리스트는 레퍼런스도 받는다", () => {
    expect(canConnect(n("R", "reference"), n("L", "list"))).toBe(true);
  });
  it("resolveEdgeRole: 레퍼런스 리스트 출력선은 ref(파랑)", () => {
    const cards = [
      n("L", "list"),
      n("R", "reference", { refs: [{ file_path: "a", type: "image" }] }),
      n("G", "generation"),
    ];
    const edges: SceneEdge[] = [
      { id: "e1", from: "R", to: "L" },
      { id: "e2", from: "L", to: "G" },
    ];
    expect(resolveEdgeRole(edges[1], byId(cards), {}, edges)).toBe("ref");
  });
});

describe("Input/Output 무선 노드", () => {
  const n = (id: string, kind: SceneCard["kind"], over: Partial<SceneCard> = {}): SceneCard => ({
    id,
    kind,
    x: 0,
    y: 0,
    ...over,
  });
  const byId = (cards: SceneCard[]) => new Map(cards.map((c) => [c.id, c] as const));

  describe("resolveInputSourceId", () => {
    it("input → output → 실제 소스로 해석", () => {
      const cards = [
        n("M", "model", { modelCfg: { model: "x" } }),
        n("O", "output", { text: "hero" }),
        n("I", "input", { channel: "O" }),
      ];
      const edges: SceneEdge[] = [{ id: "e1", from: "M", to: "O" }];
      expect(resolveInputSourceId("I", byId(cards), edges)).toBe("M");
    });
    it("input 이 아닌 카드는 자기 자신 반환", () => {
      const cards = [n("M", "model")];
      expect(resolveInputSourceId("M", byId(cards), [])).toBe("M");
    });
    it("채널 미선택/무효 output/소스 없음 → null", () => {
      const noChan = [n("I", "input")];
      expect(resolveInputSourceId("I", byId(noChan), [])).toBeNull();
      const badOut = [n("I", "input", { channel: "Z" }), n("Z", "model")]; // Z 는 output 이 아님
      expect(resolveInputSourceId("I", byId(badOut), [])).toBeNull();
      const emptyOut = [n("I", "input", { channel: "O" }), n("O", "output")];
      expect(resolveInputSourceId("I", byId(emptyOut), [])).toBeNull();
    });
    it("input 체인도 따라가며, 사이클은 null 로 끊는다", () => {
      // I1 → O1 ← I2 → O2 ← T  (I1 이 O1 을 통해 결국 T 로)
      const chain = [
        n("T", "text", { text: "hi" }),
        n("O2", "output"),
        n("I2", "input", { channel: "O2" }),
        n("O1", "output"),
        n("I1", "input", { channel: "O1" }),
      ];
      const edges: SceneEdge[] = [
        { id: "a", from: "T", to: "O2" },
        { id: "b", from: "I2", to: "O1" },
      ];
      expect(resolveInputSourceId("I1", byId(chain), edges)).toBe("T");
      // 사이클: output 의 소스가 자기를 참조하는 input
      const cyc = [n("O", "output"), n("I", "input", { channel: "O" })];
      const cycEdges: SceneEdge[] = [{ id: "c", from: "I", to: "O" }];
      expect(resolveInputSourceId("I", byId(cyc), cycEdges)).toBeNull();
    });
  });

  describe("resolvePortEdges", () => {
    it("input 소스 엣지를 실제 소스로 치환(order 보존)", () => {
      const cards = [
        n("M", "model"),
        n("O", "output"),
        n("I", "input", { channel: "O" }),
        n("G", "generation"),
      ];
      const edges: SceneEdge[] = [
        { id: "e1", from: "M", to: "O" },
        { id: "e2", from: "I", to: "G", order: 3 },
      ];
      const resolved = resolvePortEdges(byId(cards), edges);
      const toG = resolved.find((e) => e.to === "G")!;
      expect(toG.from).toBe("M"); // I → 실제 소스 M 으로 치환
      expect(toG.order).toBe(3); // order 보존
    });
    it("못 푼 input 엣지는 제외, (from,to) 중복은 하나만", () => {
      const cards = [
        n("M", "model"),
        n("O", "output"),
        n("I", "input", { channel: "O" }),
        n("Ibad", "input"), // 채널 없음
        n("G", "generation"),
      ];
      const edges: SceneEdge[] = [
        { id: "e1", from: "M", to: "O" },
        { id: "e2", from: "M", to: "G" }, // 실제 연결
        { id: "e3", from: "I", to: "G" }, // I→M 으로 치환 → M,G 중복
        { id: "e4", from: "Ibad", to: "G" }, // 못 풂 → 제외
      ];
      const resolved = resolvePortEdges(byId(cards), edges);
      const toG = resolved.filter((e) => e.to === "G");
      expect(toG).toHaveLength(1); // 중복 제거
      expect(toG[0].from).toBe("M");
    });
    it("input 을 거친 모델도 collectGenModel 로 정확히 1개 잡힌다", () => {
      const cards = [
        n("M", "model", { modelCfg: { model: "kling" } }),
        n("O", "output"),
        n("I", "input", { channel: "O" }),
        n("G", "generation"),
      ];
      const edges: SceneEdge[] = [
        { id: "e1", from: "M", to: "O" },
        { id: "e2", from: "I", to: "G" },
      ];
      const map = byId(cards);
      const cfg = collectGenModel("G", map, resolvePortEdges(map, edges));
      expect(cfg?.model).toBe("kling");
    });
  });

  describe("canConnect (input/output)", () => {
    it("output 은 출력 포트 있는 소스만 받음(view/output/input 제외)", () => {
      const O = n("O", "output");
      expect(canConnect(n("M", "model"), O)).toBe(true);
      expect(canConnect(n("G", "generation"), O)).toBe(true);
      expect(canConnect(n("V", "view"), O)).toBe(false);
    });
    it("input 은 아무것도 못 받고, output 은 소스가 될 수 없다", () => {
      expect(canConnect(n("M", "model"), n("I", "input"))).toBe(false);
      expect(canConnect(n("O", "output"), n("G", "generation"))).toBe(false);
    });
    it("input 소스는 해석된 실제 소스 종류로 검증 — model→gen OK, model→view 불가", () => {
      const cards = [
        n("M", "model"),
        n("O", "output"),
        n("I", "input", { channel: "O" }),
        n("G", "generation"),
        n("V", "view"),
      ];
      const edges: SceneEdge[] = [{ id: "e1", from: "M", to: "O" }];
      const map = byId(cards);
      expect(canConnect(map.get("I")!, map.get("G")!, map, edges)).toBe(true);
      expect(canConnect(map.get("I")!, map.get("V")!, map, edges)).toBe(false);
    });
    it("컨텍스트 없이 input 소스는 불가(안전)", () => {
      expect(canConnect(n("I", "input", { channel: "O" }), n("G", "generation"))).toBe(false);
    });
  });

  describe("resolveEdgeRole (input 색)", () => {
    it("input→gen 색은 해석된 실제 소스 종류를 따른다(model=주황)", () => {
      const cards = [
        n("M", "model"),
        n("O", "output"),
        n("I", "input", { channel: "O" }),
        n("G", "generation"),
      ];
      const edges: SceneEdge[] = [
        { id: "e1", from: "M", to: "O" },
        { id: "e2", from: "I", to: "G" },
      ];
      expect(resolveEdgeRole(edges[1], byId(cards), {}, edges)).toBe("model");
    });
  });
});

describe("실행 계획(오케스트레이션)", () => {
  const n = (id: string, kind: SceneCard["kind"], over: Partial<SceneCard> = {}): SceneCard => ({
    id,
    kind,
    x: 0,
    y: 0,
    ...over,
  });
  const byId = (cards: SceneCard[]) => new Map(cards.map((c) => [c.id, c] as const));

  it("comfy→text→generation: comfy 먼저 실행, 생성 나중", () => {
    const cards = [n("A", "comfy"), n("T", "text"), n("G", "generation")];
    const edges: SceneEdge[] = [
      { id: "e1", from: "A", to: "T" },
      { id: "e2", from: "T", to: "G" },
    ];
    const p = buildGenerationExecutionPlan("G", byId(cards), edges);
    expect(p.comfyIds).toEqual(["A"]);
    expect(p.generationIds).toEqual(["G"]);
    expect(p.steps.map((s) => s.id)).toEqual(["A", "G"]);
    expect(p.steps.find((s) => s.id === "G")?.dependsOn).toEqual(["A"]);
  });

  it("고수준 실행 계획은 무선 Input/Output 엣지를 자체 해석한다", () => {
    const cards = [
      n("A", "comfy"),
      n("O", "output"),
      n("I", "input", { channel: "O" }),
      n("T", "text"),
      n("G", "generation"),
    ];
    const edges: SceneEdge[] = [
      { id: "e1", from: "A", to: "O" },
      { id: "e2", from: "I", to: "T" },
      { id: "e3", from: "T", to: "G" },
    ];

    const p = buildGenerationExecutionPlan("G", byId(cards), edges);

    expect(p.comfyIds).toEqual(["A"]);
    expect(p.generationIds).toEqual(["G"]);
  });

  it("comfy 체인 B→A→text→generation: B, A, G 순서", () => {
    const cards = [n("A", "comfy"), n("B", "comfy"), n("T", "text"), n("G", "generation")];
    const edges: SceneEdge[] = [
      { id: "e1", from: "B", to: "A" },
      { id: "e2", from: "A", to: "T" },
      { id: "e3", from: "T", to: "G" },
    ];
    const p = buildGenerationExecutionPlan("G", byId(cards), edges);
    expect(p.steps.map((s) => s.id)).toEqual(["B", "A", "G"]);
  });

  it("상류 comfy 없으면 comfyIds 비고 생성만", () => {
    const cards = [n("T", "text"), n("G", "generation")];
    const edges: SceneEdge[] = [{ id: "e1", from: "T", to: "G" }];
    const p = buildGenerationExecutionPlan("G", byId(cards), edges);
    expect(p.comfyIds).toEqual([]);
    expect(p.generationIds).toEqual(["G"]);
  });

  it("렌더: 연결된 생성 + 직접 comfy + 상류 comfy 모두 포함", () => {
    const cards = [
      n("R", "render"),
      n("G", "generation"),
      n("A", "comfy", { y: 0 }),
      n("T", "text"),
      n("C", "comfy", { y: 10 }),
    ];
    const edges: SceneEdge[] = [
      { id: "e1", from: "G", to: "R" },
      { id: "e2", from: "A", to: "T" },
      { id: "e3", from: "T", to: "G" },
      { id: "e4", from: "C", to: "R" },
    ];
    const p = buildRenderExecutionPlan("R", byId(cards), edges);
    expect(new Set(p.comfyIds)).toEqual(new Set(["A", "C"]));
    expect(p.generationIds).toEqual(["G"]);
    // comfy 는 생성보다 앞선다
    const gi = p.steps.findIndex((s) => s.id === "G");
    expect(p.steps.findIndex((s) => s.id === "A")).toBeLessThan(gi);
  });

  it("렌더 실행 계획은 체크 해제된 생성과 직접 comfy를 제외한다", () => {
    const cards = [
      n("R", "render", { unchecked: ["G2", "C"] }),
      n("G1", "generation"),
      n("G2", "generation"),
      n("C", "comfy"),
    ];
    const edges: SceneEdge[] = [
      { id: "e1", from: "G1", to: "R" },
      { id: "e2", from: "G2", to: "R" },
      { id: "e3", from: "C", to: "R" },
    ];

    const p = buildRenderExecutionPlan("R", byId(cards), edges);

    expect(p.generationIds).toEqual(["G1"]);
    expect(p.comfyIds).toEqual([]);
  });

  it("카드 이동은 같은 계획이지만 렌더 체크 변경은 이전 계획을 폐기한다", () => {
    const cards = [
      n("R", "render"),
      n("G", "generation"),
      n("A", "comfy", { y: 0 }),
      n("T", "text"),
    ];
    const edges: SceneEdge[] = [
      { id: "e1", from: "G", to: "R" },
      { id: "e2", from: "A", to: "T" },
      { id: "e3", from: "T", to: "G" },
    ];
    const snapshot = buildRenderExecutionPlan("R", byId(cards), edges);
    const moved = cards.map((card) => ({ ...card, x: card.x + 500, y: card.y + 300 }));
    const unchecked = cards.map((card) =>
      card.id === "R" ? { ...card, unchecked: ["G"] } : card,
    );

    expect(isRenderExecutionPlanCurrent(snapshot, "R", byId(moved), edges)).toBe(true);
    expect(isRenderExecutionPlanCurrent(snapshot, "R", byId(unchecked), edges)).toBe(false);
    expect(
      isRenderExecutionPlanCurrent(
        snapshot,
        "R",
        byId(cards),
        edges.filter((edge) => edge.id !== "e1"),
      ),
    ).toBe(false);
  });

  it("생성카드의 Comfy 의존 연결이 바뀌면 이전 계획을 폐기한다", () => {
    const cards = [
      n("A", "comfy"),
      n("B", "comfy"),
      n("T", "text"),
      n("G", "generation"),
    ];
    const originalEdges: SceneEdge[] = [
      { id: "e1", from: "A", to: "T" },
      { id: "e2", from: "T", to: "G" },
    ];
    const changedEdges: SceneEdge[] = [
      { id: "e3", from: "B", to: "T" },
      { id: "e2", from: "T", to: "G" },
    ];
    const snapshot = buildGenerationExecutionPlan("G", byId(cards), originalEdges);

    expect(
      isGenerationExecutionPlanCurrent(snapshot, "G", byId(cards), changedEdges),
    ).toBe(false);
  });

  it("사이클은 skippedByCycle 로", () => {
    const cards = [n("A", "comfy"), n("B", "comfy"), n("G", "generation")];
    const edges: SceneEdge[] = [
      { id: "e1", from: "A", to: "B" },
      { id: "e2", from: "B", to: "A" },
      { id: "e3", from: "A", to: "G" },
    ];
    const p = buildGenerationExecutionPlan("G", byId(cards), edges);
    // A↔B 사이클 → 둘 다 실행 불가, 그에 의존하는 G 도 실행 불가.
    expect(p.skippedByCycle.sort()).toEqual(["A", "B", "G"]);
  });
});

describe("collectListInputs 텍스트 상류 추적(#4)", () => {
  const n = (id: string, kind: SceneCard["kind"], over: Partial<SceneCard> = {}): SceneCard => ({ id, kind, x: 0, y: 0, ...over });
  const byId = (cards: SceneCard[]) => new Map(cards.map((c) => [c.id, c] as const));
  const e = (from: string, to: string): SceneEdge => ({ id: `${from}-${to}`, from, to });

  it("comfy→text(빈)→list 면 comfy 텍스트가 리스트로 전달된다(직접 연결과 동일)", () => {
    const cards = [
      n("CF", "comfy", { comfyCfg: { outputs: [{ kind: "text", text: "불꽃" }] } }),
      n("T", "text"),
      n("L", "list"),
    ];
    const li = collectListInputs("L", byId(cards), [e("CF", "T"), e("T", "L")]);
    expect(li.kind).toBe("text");
    expect(li.text).toBe("불꽃");
  });

  it("자기 텍스트가 있으면 그대로(상류 무시 아님, 우선)", () => {
    const cards = [n("T", "text", { text: "내가쓴것" }), n("L", "list")];
    const li = collectListInputs("L", byId(cards), [e("T", "L")]);
    expect(li.text).toBe("내가쓴것");
  });

  it("list↔text 순환이어도 무한루프 없이 반환", () => {
    const cards = [n("T", "text"), n("L", "list")];
    expect(() => collectListInputs("L", byId(cards), [e("T", "L"), e("L", "T")])).not.toThrow();
  });
});
