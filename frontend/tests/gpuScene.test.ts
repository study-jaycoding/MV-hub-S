// GPU 판 그릴 모델(features/canvas/gpu/gpuScene) — 모습 열쇠·지원 판정·선 모양·단순화(docs/status/캔버스_GPU판설계_2026-11-11.md 계약 draw·geometry).
import { describe, expect, it } from "vitest";
import { buildGpuScene, edgeStyle, flattenPath, stableKey, type GpuSceneInput } from "../src/features/canvas/gpu/gpuScene";
import type { BoardBuildContext } from "../src/lib/boardCanvasDraw";
import { edgePathMerged } from "../src/lib/sceneEdges";
import type { SceneCard } from "../src/lib/scenes";

const build: BoardBuildContext = {
  workspaceId: "ws", fill: true, cardsById: new Map(), resolvedEdges: [], genData: {},
  filters: { typeFilter: "all", colorFilter: new Set(), tagFilter: new Set(), sharedOnly: false, commentOnly: false, finalOnly: false } as never,
  folderSel: null, modelBlocked: () => false, waiting: () => false, genMissing: () => false, genKnown: () => true, disabled: () => false,
  hideFailed: false, lastViewedCardId: null, logo: "/logo.svg",
};
const text = (id: string, x: number, body = "hello") => ({ id, kind: "text", x, y: 0, text: body }) as unknown as SceneCard;
const input = (over: Partial<GpuSceneInput> = {}): GpuSceneInput => ({
  cards: [{ card: text("t", 0), w: 260, h: 120 }], build, selected: new Set(), glow: new Set(), offServer: new Set(), listKind: () => null,
  lines: [], dots: [], groups: [], lowLod: false, variantCount: () => 1, folderChip: () => undefined, refTypeLabel: () => "이미지", ...over,
});

describe("모습 열쇠", () => {
  it("위치·고름만 바뀌면 열쇠가 같고(다시 굽지 않음), 글이 바뀌면 달라진다", () => {
    const a = buildGpuScene(input()).requests.find((r) => r.id === "t")!;
    const moved = buildGpuScene(input({ cards: [{ card: text("t", 500), w: 260, h: 120 }], selected: new Set(["t"]) })).requests.find((r) => r.id === "t")!;
    expect(moved.key).toBe(a.key);
    const edited = buildGpuScene(input({ cards: [{ card: text("t", 0, "bye"), w: 260, h: 120 }] })).requests.find((r) => r.id === "t")!;
    expect(edited.key).not.toBe(a.key);
    const resized = buildGpuScene(input({ cards: [{ card: text("t", 0), w: 260, h: 160 }] })).requests.find((r) => r.id === "t")!;
    expect(resized.key).not.toBe(a.key);
  });

  it("고름은 테두리(셰이더 값)로만 — 노드 색 2px, 서버에 없는 레퍼런스면 빨강", () => {
    const off = buildGpuScene(input()).cards[0];
    expect(off.border[3]).toBe(0);
    const on = buildGpuScene(input({ selected: new Set(["t"]) })).cards[0];
    expect(on.border.slice(0, 3).map((v) => Math.round(v * 255))).toEqual([0xb5, 0x7a, 0xff]);
    const ref = { id: "r", kind: "reference", x: 0, y: 0, refs: [] } as unknown as SceneCard;
    const red = buildGpuScene(input({ cards: [{ card: ref, w: 260, h: 195 }], selected: new Set(["r"]), offServer: new Set(["r"]) })).cards[0];
    expect(red.border.slice(0, 3).map((v) => Math.round(v * 255))).toEqual([0xff, 0x6b, 0x6b]);
  });

  it("stableKey 는 키 순서와 무관", () => {
    expect(stableKey({ b: 1, a: [1, { d: 2, c: 3 }] })).toBe(stableKey({ a: [1, { c: 3, d: 2 }], b: 1 }));
  });
});

describe("지원 판정", () => {
  it("세트·Comfy·View 같은 미지원 종류는 undrawable 로 알린다(그 씬은 GPU 판에 안 들어감)", () => {
    const m = buildGpuScene(input({ cards: [
      { card: text("t", 0), w: 260, h: 120 },
      { card: { id: "s", kind: "set", x: 0, y: 0 } as unknown as SceneCard, w: 260, h: 120 },
      { card: { id: "c", kind: "comfy", x: 0, y: 0 } as unknown as SceneCard, w: 260, h: 120 },
    ] }));
    expect(m.undrawable).toEqual(["s", "c"]);
    expect(m.cards.map((c) => c.id)).toEqual(["t"]);
  });
});

describe("연결선", () => {
  it("합쳐짐(m1·m2) path 를 펴면 양 끝과 곧은 줄 끝이 그대로다", () => {
    const pts = flattenPath(edgePathMerged(100, 50, 400, 250, true, true));
    expect(pts.slice(0, 4)).toEqual([100, 50, 100 + 28 / 3, 50]);
    expect(pts.slice(-4)).toEqual([400 - 28 / 3, 250, 400, 250]);
  });

  it("클래스 우선순위는 CSS 순서 — 고른 레퍼런스 선은 파랑 1.6, 회색 기본선·우회 점선·가위 예고", () => {
    const sel = edgeStyle("scene-edge ref onsel");
    expect(sel.width).toBe(1.6);
    expect(sel.color.map((v) => Math.round(v * 255)).slice(0, 3)).toEqual([0x7f, 0xa9, 0xff]);
    expect(edgeStyle("scene-edge idle")).toMatchObject({ width: 1.2, dash: 0 });
    expect(edgeStyle("scene-edge bridge")).toMatchObject({ dash: 2, gap: 6 });
    const cut = edgeStyle("scene-edge idle cut");
    expect(cut.width).toBe(3);
    expect(cut.color[3]).toBe(1);
  });
});

describe("단순화(25% 이하)", () => {
  it("회색 끝 점·결과 수 배지는 숨기고, 고른 카드의 이름표는 남긴다", () => {
    const gen = { id: "g", kind: "generation", x: 0, y: 0, genId: "x" } as unknown as SceneCard;
    const base = input({
      cards: [{ card: gen, w: 260, h: 260 }, { card: text("t", 300), w: 260, h: 120 }], selected: new Set(["t"]), variantCount: () => 3,
      dots: [{ x: 1, y: 1, cls: "scene-dot idle" }, { x: 2, y: 2, cls: "scene-dot ref" }],
    });
    const near = buildGpuScene(base);
    expect(near.quads.map((q) => q.id).sort()).toEqual(["label:t", "multi:g"]);
    expect(near.dots).toHaveLength(2);
    const far = buildGpuScene({ ...base, lowLod: true });
    expect(far.quads.map((q) => q.id)).toEqual(["label:t"]);
    expect(far.dots).toHaveLength(1);
  });
});
