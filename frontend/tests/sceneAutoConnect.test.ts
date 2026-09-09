// 캔버스 'c' 자동 연결 방향 규칙 — Jay 2026-09-09: 텍스트는 항상 생성으로, 레퍼런스·리스트는 텍스트로.
//  (코덱스 1·2차 리뷰: 순환·혼합 입력·텍스트 리스트→생성 차단 회귀까지 고정)
import { describe, it, expect } from "vitest";
import { planAutoConnections } from "../src/lib/sceneAutoConnect";
import type { SceneCard, SceneEdge } from "../src/lib/scenes";

const node = (id: string, kind: SceneCard["kind"], over: Partial<SceneCard> = {}): SceneCard => ({
  id,
  kind,
  x: 0,
  y: 0,
  ...over,
});
const byId = (cards: SceneCard[]) => new Map(cards.map((c) => [c.id, c] as const));
// 순서 무관 비교 — 계획의 의미(어떤 연결이 생기나)만 본다.
const links = (pairs: Array<[string, string]>) => [...pairs.map(([f, t]) => `${f}>${t}`)].sort();
const plan = (selected: SceneCard[], extra: SceneCard[] = [], edges: SceneEdge[] = []) =>
  links(planAutoConnections(selected, byId([...selected, ...extra]), edges));

const gen = (id: string, x: number) => node(id, "generation", { x, refs: [], genId: null });
const text = (id: string, x: number, t = "") => node(id, "text", { x, text: t });
const ref = (id: string, x: number, y = 0) => node(id, "reference", { x, y, refs: [] });
const list = (id: string, x: number) => node(id, "list", { x });
const textListEdges = (listId: string): { extra: SceneCard[]; edges: SceneEdge[] } => ({
  extra: [node("T0", "text", { text: "a" })],
  edges: [{ id: "e-t0", from: "T0", to: listId }],
});

describe("planAutoConnections — 텍스트 ↔ 생성", () => {
  it("생성 카드가 텍스트보다 왼쪽에 있어도 텍스트 → 생성(예전엔 위치로 뒤집혀 생성 → 텍스트가 됐다)", () => {
    expect(plan([gen("G", 0), text("T", 300)])).toEqual(["T>G"]);
    expect(plan([text("T", 300), gen("G", 0)])).toEqual(["T>G"]);
    expect(plan([gen("G", 300), text("T", 0)])).toEqual(["T>G"]);
  });
  it("텍스트·생성·view: 텍스트는 가장 가까운 층(생성)까지만, 생성 → view", () => {
    expect(plan([text("T", 0), gen("G", 100), node("V", "view", { x: 400 })])).toEqual(["G>V", "T>G"]);
  });
  it("텍스트·생성·빈 리스트: 텍스트 → 생성 → 리스트. 리스트 → 텍스트(순환)는 만들지 않는다 (코덱스 리뷰 ②)", () => {
    expect(plan([text("T", 0), gen("G", 200), list("L", 400)])).toEqual(["G>L", "T>G"]);
  });
  it("텍스트·이미지 comfy·빈 리스트: comfy → 리스트만. 텍스트를 리스트에 넣어 혼합 입력을 만들지 않는다 (코덱스 2차 ②)", () => {
    const comfy = node("C", "comfy", {
      x: 200,
      comfyCfg: { status: "idle", outputs: [{ kind: "image", url: "http://x/a.png" }] },
    });
    expect(plan([text("T", 0), comfy, list("L", 400)])).toEqual(["C>L"]);
  });
  it("텍스트 리스트 + 생성: 리스트 → 생성(예전 보호 조건이 이 정상 연결까지 막았다, 코덱스 2차 ③)", () => {
    const { extra, edges } = textListEdges("L");
    expect(plan([list("L", 200), gen("G", 400)], extra, edges)).toEqual(["L>G"]);
    expect(plan([list("L", 600), gen("G", 400)], extra, edges)).toEqual(["L>G"]); // 위치 무관
  });
  it("레퍼런스 리스트 + 생성 + 텍스트: 리스트 → 텍스트 → 생성 + 리스트 → 생성(레퍼런스 + 텍스트 + 생성과 같은 모양). 생성을 레퍼런스 리스트에 넣어 순환·혼합을 만들지 않는다 (코덱스 3차)", () => {
    const refListEdges: SceneEdge[] = [{ id: "e", from: "R", to: "L" }];
    expect(plan([gen("G", 200), list("L", 400), text("T", 0)], [ref("R", 0)], refListEdges)).toEqual(["L>G", "L>T", "T>G"]);
  });
  it("빈 리스트 + 레퍼런스 + 이미지 comfy + 텍스트: 레퍼런스 → 리스트 → 텍스트, comfy 는 혼합이 되므로 리스트에 넣지 않는다 (코덱스 3차)", () => {
    const comfy = node("C", "comfy", {
      x: 200,
      comfyCfg: { status: "idle", outputs: [{ kind: "image", url: "http://x/a.png" }] },
    });
    // comfy → 리스트는 혼합이라 막히고, 반대 방향(레퍼런스 리스트 → comfy 미디어 입력)이 유효해 그쪽으로 이어진다.
    expect(plan([ref("R", 0), comfy, list("L", 400), text("T", 200)])).toEqual(["L>C", "L>T", "R>L"]);
  });
  it("텍스트 + 텍스트 리스트 + 생성: 텍스트 → 리스트 → 생성 사슬만(텍스트 → 생성 직접 연결은 프롬프트 중복이라 생략)", () => {
    const { extra, edges } = textListEdges("L");
    expect(plan([text("T", 0, "b"), list("L", 200), gen("G", 400)], extra, edges)).toEqual(["L>G", "T>L"]);
  });
});

describe("planAutoConnections — 레퍼런스·리스트 ↔ 텍스트", () => {
  it("레퍼런스 + 텍스트 → 레퍼런스 → 텍스트(예전엔 같은 층이라 아무것도 안 이었다)", () => {
    expect(plan([ref("R", 300), text("T", 0)])).toEqual(["R>T"]);
  });
  it("리스트 + 텍스트 → 리스트 → 텍스트(빈 리스트·레퍼런스 리스트). 텍스트 → 리스트는 만들지 않는다", () => {
    expect(plan([list("L", 300), text("T", 0)])).toEqual(["L>T"]);
    const refListEdges: SceneEdge[] = [{ id: "e", from: "R", to: "L" }];
    expect(plan([list("L", 300), text("T", 0)], [ref("R", 0)], refListEdges)).toEqual(["L>T"]);
  });
  it("텍스트를 모으는 리스트 + 텍스트 → 텍스트 → 리스트(수집)", () => {
    const { extra, edges } = textListEdges("L");
    expect(plan([list("L", 300), text("T", 0, "b")], extra, edges)).toEqual(["T>L"]);
  });
  it("레퍼런스 2 + 리스트 + 텍스트 → 레퍼런스들 → 리스트 → 텍스트 (레퍼런스 → 텍스트 직접 연결·텍스트 → 리스트 없음)", () => {
    expect(plan([ref("R1", 0, 0), ref("R2", 0, 200), list("L", 400), text("T", 200)])).toEqual([
      "L>T",
      "R1>L",
      "R2>L",
    ]);
  });
  it("레퍼런스 + 텍스트 + 렌더: 렌더는 레퍼런스를 못 받으니 레퍼런스 → 텍스트는 그대로 만든다 (코덱스 리뷰 ③)", () => {
    expect(plan([ref("R", 0), text("T", 200), node("RN", "render", { x: 400 })])).toEqual(["R>T"]);
  });
  it("레퍼런스 + 텍스트 + 텍스트 리스트: 레퍼런스 → 텍스트, 텍스트 → 리스트. 레퍼런스를 텍스트 리스트에 넣지 않는다", () => {
    const { extra, edges } = textListEdges("L");
    expect(plan([ref("R", 0), text("T", 200, "b"), list("L", 400)], extra, edges)).toEqual(["R>T", "T>L"]);
  });
  it("레퍼런스 + 텍스트 + 생성 → 레퍼런스 → 텍스트 · 텍스트 → 생성 · 레퍼런스 → 생성", () => {
    expect(plan([ref("R", 0), text("T", 200), gen("G", 400)])).toEqual(["R>G", "R>T", "T>G"]);
  });
});

describe("planAutoConnections — 기존 규칙 유지", () => {
  it("생성 카드만: 왼쪽 → 오른쪽 사슬(순서 있음)", () => {
    const pairs = planAutoConnections([gen("A", 200), gen("B", 0), gen("C", 400)], byId([]), []);
    expect(pairs).toEqual([["B", "A"], ["A", "C"]]);
  });
  it("생성·리스트·view: 생성 → 리스트 → view (생성 → view 는 안 만든다)", () => {
    expect(plan([gen("G", 0), list("L", 200), node("V", "view", { x: 400 })])).toEqual(["G>L", "L>V"]);
  });
  it("레퍼런스 리스트 + 생성: 위치와 무관하게 리스트 → 생성(예전엔 리스트가 오른쪽이면 생성 → 리스트로 혼합 입력을 만들었다)", () => {
    const refListEdges: SceneEdge[] = [{ id: "e", from: "R", to: "L" }];
    expect(plan([list("L", 0), gen("G", 400)], [ref("R", 0)], refListEdges)).toEqual(["L>G"]);
    expect(plan([list("L", 600), gen("G", 400)], [ref("R", 0)], refListEdges)).toEqual(["L>G"]);
  });
  it("빈 리스트 + 생성: 모호한 쌍은 위치로(왼쪽 → 오른쪽, 예전 그대로)", () => {
    expect(plan([list("L", 0), gen("G", 400)])).toEqual(["L>G"]);
    expect(plan([list("L", 600), gen("G", 400)])).toEqual(["G>L"]);
  });
  it("Set + 생성 → Set → 생성", () => {
    expect(plan([node("S", "set", { x: 300, setCfg: { tagsText: "" } }), gen("G", 0)])).toEqual(["S>G"]);
  });
  it("텍스트끼리는 잇지 않는다 · 카드 1개 이하면 빈 계획", () => {
    expect(plan([text("A", 0), text("B", 100)])).toEqual([]);
    expect(plan([text("T", 0)])).toEqual([]);
  });
});
