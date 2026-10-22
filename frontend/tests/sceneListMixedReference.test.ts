// 리스트에 레퍼런스 카드와 생성물 카드를 함께 이으면 레퍼런스 리스트다(Jay 2026-10-22 — 폴더 창에서 가져온 생성물을 레퍼런스들과
// 한 리스트에 넣으면 '잘못된 입력'이 떴다. 생성 카드에 바로 이으면 레퍼런스로 들어가는데). 생성물 항목은 그 저장된 결과물이 레퍼런스다.
// 생성물만 모은 리스트는 지금처럼 생성물 리스트(View·렌더), 텍스트가 섞이면 지금처럼 쓸 수 없다. 'c' 자동 연결은 어느 방향이든
// 섞인 리스트를 새로 만들지 않는다(섞기는 손으로만). 계약·결정: docs/status/캔버스_리스트_생성물레퍼런스_2026-10-22.md
import { describe, expect, it } from "vitest";
import { gatherCanvasReferences } from "../src/features/canvas/references";
import { planAutoConnections } from "../src/lib/sceneAutoConnect";
import { gatherComfyMedia } from "../src/lib/sceneComfyInputs";
import { collectGenRefs, collectListInputs, refLaneOrderIndex } from "../src/lib/sceneEdges";
import { collectSceneGenerationCardInput } from "../src/lib/sceneGenerationInputs";
import type { SceneCard, SceneEdge } from "../src/lib/scenes";
import type { Generation } from "../src/types";

const n = (id: string, kind: SceneCard["kind"], over: Partial<SceneCard> = {}): SceneCard => ({ id, kind, x: 0, y: 0, ...over });
const byId = (cards: SceneCard[]) => new Map(cards.map((card) => [card.id, card] as const));
const ref = (id: string, path: string, x = 0) => n(id, "reference", { x, refs: [{ file_path: path, type: "image", name: path }] });
const genCard = (id: string, genId: string, x = 0) => n(id, "generation", { x, genId, genIds: [genId], refs: [{ file_path: "own-input.png", type: "image" }] });
const generations = {
  g1: { id: "g1", prompt: "p", status: "done", assets: [{ file_path: "https://cdn.example/g1.png", type: "image", thumbnail_path: "https://cdn.example/g1_t.png" }] },
  g2: { id: "g2", prompt: "p", status: "done", assets: [{ file_path: "https://cdn.example/g2.png", type: "image" }] },
} as unknown as Record<string, Generation>;
const edge = (from: string, to: string, order?: number): SceneEdge => ({ id: `${from}>${to}`, from, to, ...(order == null ? {} : { order }) });

describe("레퍼런스 + 생성물 리스트", () => {
  const cards = [n("L", "list"), ref("R1", "a.png"), genCard("G", "g1"), ref("R2", "b.png"), n("N", "generation", { refs: [] })];
  const edges = [edge("R1", "L", 0), edge("G", "L", 1), edge("R2", "L", 2), edge("L", "N")];

  it("레퍼런스 리스트로 판정하고 항목을 연결 순서대로(생성물 카드 포함) 펼친다", () => {
    const li = collectListInputs("L", byId(cards), edges);
    expect(li.kind).toBe("reference");
    expect(li.referenceCardIds).toEqual(["R1", "G", "R2"]);
  });

  it("생성 카드는 그 리스트에서 레퍼런스를 순서대로 받는다 — 생성물 항목은 결과물(그 카드의 입력 레퍼런스가 아니다)", () => {
    const refs = gatherCanvasReferences("N", cards, edges, generations);
    expect(refs.map((item) => [item.file_path, item.source_gen_id ?? null])).toEqual([
      ["a.png", null],
      ["https://cdn.example/g1.png", "g1"],
      ["b.png", null],
    ]);
  });

  it("Comfy 입력도 같은 순서로 생성물을 미디어로 받는다", () => {
    const comfyCards = [...cards.filter((card) => card.id !== "N"), n("C", "comfy", { comfyCfg: { status: "idle" } })];
    const media = gatherComfyMedia("C", comfyCards, [...edges.filter((item) => item.to !== "N"), edge("L", "C")], generations);
    expect(media.map((item) => item.source_gen_id ?? null)).toEqual([null, "g1", null]);
  });

  it("중첩: 생성물 리스트·렌더를 레퍼런스 리스트에 넣으면 그 안 생성물들이 항목이 된다", () => {
    const nested = [
      n("L", "list"), ref("R1", "a.png"), n("GL", "list"), genCard("G1", "g1"), genCard("G2", "g2"),
      n("RN", "render"), genCard("G3", "g1"),
    ];
    const nestedEdges = [edge("G1", "GL", 0), edge("G2", "GL", 1), edge("G3", "RN", 0), edge("R1", "L", 0), edge("GL", "L", 1), edge("RN", "L", 2)];
    const li = collectListInputs("L", byId(nested), nestedEdges);
    expect(li.kind).toBe("reference");
    expect(li.referenceCardIds).toEqual(["R1", "G1", "G2", "G3"]);
  });

  it("생성물만이면 생성물 리스트 그대로, 텍스트가 섞이면 그대로 쓸 수 없다", () => {
    const onlyGen = collectListInputs("L", byId([n("L", "list"), genCard("G", "g1"), genCard("H", "g2")]), [edge("G", "L"), edge("H", "L")]);
    expect(onlyGen.kind).toBe("generation");
    const withText = collectListInputs("L", byId([...cards, n("T", "text", { text: "t" })]), [...edges, edge("T", "L", 3)]);
    expect(withText.kind).toBe("invalid");
  });

  it("생성 카드로 들어오는 리스트 연결선의 순번은 생성물 항목도 레퍼런스 순번(source_gen_id)으로 찾는다", () => {
    const target = n("N", "generation", { refs: [{ file_path: "https://cdn.example/g1.png", type: "image", source_gen_id: "g1" }] });
    const only = [n("L", "list"), genCard("G", "g1"), ref("R9", "z.png"), target];
    const order = refLaneOrderIndex("N", byId(only), [edge("G", "L", 0), edge("R9", "L", 1), edge("L", "N")]);
    expect(order.get("L>N")).toBe(0);
  });

  it("실행 시 Comfy 출력 모으기: 섞인 리스트 안 Comfy 의 이번 실행 결과도 실린다", () => {
    const comfy = n("C", "comfy", { comfyCfg: { status: "idle" } });
    const run = [n("L", "list"), ref("R1", "a.png"), comfy, n("N", "generation", { refs: [] })];
    const runEdges = [edge("R1", "L", 0), edge("C", "L", 1), edge("L", "N")];
    const overlay = { C: [{ kind: "image" as const, url: "https://comfy.example/out.png" }] };
    expect(collectGenRefs("N", byId(run), runEdges, overlay).map((item) => item.file_path)).toEqual(["https://comfy.example/out.png"]);
  });

  it("이번 실행 결과가 있으면 Comfy → 렌더 → 리스트 경로에서도 옛 저장 결과를 뺀다", () => {
    const comfy = n("C", "comfy", { genIds: ["old"], genId: "old", comfyCfg: { status: "idle" } });
    const target = n("N", "generation", { refs: [{ file_path: "https://old.example/old.png", type: "image", source_gen_id: "old", from_card: true }] });
    const run = [n("L", "list"), ref("R1", "a.png"), n("RN", "render"), comfy, target];
    const runEdges = [edge("C", "RN", 0), edge("R1", "L", 0), edge("RN", "L", 1), edge("L", "N")];
    const overlay = { C: [{ kind: "image" as const, url: "https://comfy.example/new.png" }] };
    const input = collectSceneGenerationCardInput("N", byId(run), runEdges, overlay);
    expect(input?.refs.map((item) => item.file_path)).toEqual(["https://comfy.example/new.png"]);
  });
});

describe("'c' 자동 연결 — 어느 방향이든 섞인 리스트를 새로 만들지 않는다", () => {
  const mixed = [ref("R", "a.png"), genCard("G0", "g1"), n("L", "list", { x: 600 })];
  const mixedEdges = [edge("R", "L", 0), edge("G0", "L", 1)];
  const blank = (id: string, x: number) => n(id, "generation", { x, refs: [], genId: null });

  it("이미 섞인 리스트가 오른쪽에 있어도 생성 카드와 고르면 리스트 → 생성(생성을 리스트 안에 넣지 않는다)", () => {
    const g2 = blank("G2", 400);
    expect(planAutoConnections([g2, mixed[2]], byId([...mixed, g2]), mixedEdges)).toEqual([["L", "G2"]]);
  });

  it("레퍼런스 + 생성물 리스트는 잇지 않는다(생성물 리스트가 레퍼런스 리스트로 바뀌지 않게)", () => {
    const genList = [genCard("G1", "g1"), n("L", "list", { x: 400 }), ref("R", "a.png", 0)];
    expect(planAutoConnections([genList[2], genList[1]], byId(genList), [edge("G1", "L", 0)])).toEqual([]);
  });

  it("이미 있는 중첩(빈 리스트 I → 레퍼런스가 든 바깥 O)에서 생성과 I 를 고르면 잇지 않는다 — G → I 가 바깥 O 를 섞는다", () => {
    const nested = [ref("R", "a.png"), n("O", "list", { x: 800 }), n("I", "list", { x: 400 }), blank("G", 0)];
    expect(planAutoConnections([nested[3], nested[2]], byId(nested), [edge("R", "O", 0), edge("I", "O", 1)])).toEqual([]);
  });

  it("레퍼런스 리스트 L 이 바깥 O 에 중첩돼 있어도 생성과 L 을 고르면 리스트 → 생성(반대 방향은 어느 리스트도 바꾸지 않는다)", () => {
    const nested = [ref("R", "a.png"), n("L", "list", { x: 400 }), n("O", "list", { x: 800 }), blank("G", 0)];
    expect(planAutoConnections([nested[3], nested[1]], byId(nested), [edge("R", "L", 0), edge("L", "O", 0)])).toEqual([["L", "G"]]);
  });

  it("렌더를 받는 리스트도 섞지 않는다 — 빈 렌더 RN → 레퍼런스가 든 L 에서 생성(또는 생성 Comfy)과 RN 을 고르면 잇지 않는다", () => {
    const base = [ref("R", "a.png"), n("L", "list", { x: 800 }), n("RN", "render", { x: 400 })];
    const edges = [edge("R", "L", 0), edge("RN", "L", 1)];
    const g = blank("G", 0);
    expect(planAutoConnections([g, base[2]], byId([...base, g]), edges)).toEqual([]);
    const comfy = n("C", "comfy", { x: 0, genIds: ["g1"], genId: "g1", comfyCfg: { status: "idle" } });
    expect(planAutoConnections([comfy, base[2]], byId([...base, comfy]), edges)).toEqual([]);
    // 렌더가 리스트에 안 이어져 있으면 지금처럼 생성 → 렌더
    expect(planAutoConnections([g, base[2]], byId([...base, g]), [edge("R", "L", 0)])).toEqual([["G", "RN"]]);
  });

  it("이미 섞인 리스트에 레퍼런스를 더하는 것은 된다", () => {
    const r2 = ref("R2", "b.png", 0);
    expect(planAutoConnections([r2, mixed[2]], byId([...mixed, r2]), mixedEdges)).toEqual([["R2", "L"]]);
  });
});
