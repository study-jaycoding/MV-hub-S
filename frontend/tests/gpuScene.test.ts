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
  hideFailed: false, lastViewedCardId: null, logo: "/logo.svg", refStatus: () => undefined, refHeldTitle: () => undefined,
};
const text = (id: string, x: number, body = "hello") => ({ id, kind: "text", x, y: 0, text: body }) as unknown as SceneCard;
const input = (over: Partial<GpuSceneInput> = {}): GpuSceneInput => ({
  cards: [{ card: text("t", 0), w: 260, h: 120 }], build, selected: new Set(), glow: new Set(), offServer: new Set(), listKind: () => null,
  lines: [], dots: [], groups: [], variantCount: () => 1, folderChip: () => undefined, refTypeLabel: () => "이미지", ...over,
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
  it("Comfy·View 같은 미지원 종류는 undrawable 로 알린다(그 씬은 GPU 판에 안 들어감) — 세트는 그린다", () => {
    const m = buildGpuScene(input({ cards: [
      { card: text("t", 0), w: 260, h: 120 },
      { card: { id: "s", kind: "set", x: 0, y: 0, setCfg: { tagsText: "#a, b" } } as unknown as SceneCard, w: 260, h: 120 },
      { card: { id: "c", kind: "comfy", x: 0, y: 0 } as unknown as SceneCard, w: 260, h: 120 },
      { card: { id: "v", kind: "view", x: 0, y: 0 } as unknown as SceneCard, w: 260, h: 120 },
    ] }));
    expect(m.undrawable).toEqual(["c", "v"]);
    expect(m.cards.map((c) => c.id)).toEqual(["t", "s"]);
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
  it("회색 끝 점·결과 수 배지는 hideLow 로 표시(GPU 판이 25% 이하에서 거른다), 고른 카드의 이름표·배지는 남긴다", () => {
    const gen = { id: "g", kind: "generation", x: 0, y: 0, genId: "x" } as unknown as SceneCard;
    const base = input({
      cards: [{ card: gen, w: 260, h: 260 }, { card: text("t", 300), w: 260, h: 120 }], selected: new Set(["t"]), variantCount: () => 3,
      dots: [{ x: 1, y: 1, cls: "scene-dot idle" }, { x: 2, y: 2, cls: "scene-dot ref" }],
    });
    const m = buildGpuScene(base);
    expect(m.quads.map((q) => q.id).sort()).toEqual(["label:t", "multi:g"]);
    expect(m.quads.filter((q) => !q.hideLow).map((q) => q.id)).toEqual(["label:t"]);
    expect(m.dots.filter((d) => !d.hideLow)).toHaveLength(1);
    const picked = buildGpuScene({ ...base, selected: new Set(["g"]) });
    expect(picked.quads.find((q) => q.id === "multi:g")?.hideLow).toBeUndefined();
  });

  it("모습 열쇠는 짧은 해시 — 같은 값이면 같고 글이 한 자만 달라도 다르다", async () => {
    const { appearanceKey } = await import("../src/features/canvas/gpu/gpuScene");
    const long = "x".repeat(5000);
    expect(appearanceKey({ a: long })).toBe(appearanceKey({ a: long }));
    expect(appearanceKey({ a: long })).not.toBe(appearanceKey({ a: long + "y" }));
    expect(appearanceKey({ a: long }).length).toBeLessThan(24);
  });
});

describe("포트·쌓임(카드에 딸린 조각)", () => {
  const gen = { id: "g", kind: "generation", x: 100, y: 0, genId: "x" } as unknown as SceneCard;
  const ports = { linkedPorts: (id: string) => (id === "g" ? "in in-ref" : undefined), laneDelta: (lane: string) => ({ model: -30, ref: -10, text: 10, set: 30 })[lane] ?? 0, portGap: 24 };
  const rings = (m: ReturnType<typeof buildGpuScene>) => m.rects.filter((r) => r.owner === "g" && r.radius <= 8);

  it("고른 생성 카드 — 입력 네 칸(칸 색)·출력 하나의 빈 고리(지름 16·테두리 2), 자리는 카드 밖 24px·칸 어긋남", () => {
    const m = buildGpuScene(input({ cards: [{ card: gen, w: 260, h: 200 }], selected: new Set(["g"]), ...ports }));
    const r = rings(m);
    expect(r).toHaveLength(5);
    expect(r.every((x) => x.w === 16 && x.borderWidth === 2 && x.fill[3] === 0)).toBe(true);
    const ins = r.filter((x) => x.x + 8 === 100 - 24).map((x) => [x.y + 8, x.border.slice(0, 3).map((v) => Math.round(v * 255)).join(",")]);
    expect(ins).toEqual([[70, "255,184,77"], [90, "127,169,255"], [110, "181,122,255"], [130, "232,195,65"]]);
    expect(r.find((x) => x.x + 8 === 100 + 260 + 24)?.y).toBe(100 - 8);
  });

  it("고르지 않은 생성 카드 — 입력이 하나라도 이어졌으면 선 없는 칸만 회색 작은 빈 원(단순화에서 숨김), 아무 입력도 없으면 없음", () => {
    const m = buildGpuScene(input({ cards: [{ card: gen, w: 260, h: 200 }], ...ports }));
    const r = rings(m);
    expect(r.map((x) => x.y + 5)).toEqual([70, 110, 130]); // model·text·set (ref 는 이어짐)
    expect(r.every((x) => x.w === 10 && x.hideLow)).toBe(true);
    const none = buildGpuScene(input({ cards: [{ card: gen, w: 260, h: 200 }], ...ports, linkedPorts: () => undefined }));
    expect(rings(none)).toEqual([]);
  });

  it("그룹 머리줄 바탕 = DOM 처럼 색을 안 정한 그룹은 어두운 반투명(강조색을 섞지 않음), 색을 정한 그룹은 그 색 36%", () => {
    const fills = (color: string | null) => {
      const m = buildGpuScene(input({ groups: [{ id: "G", x: 0, y: 0, w: 400, h: 300, color, name: "묶음", count: 1, collapsed: false, selected: false }] }));
      const req = m.requests.find((r) => r.id === "group:G")!;
      const seen: string[] = [];
      const g = new Proxy({ fillStyle: "" } as Record<string, unknown>, {
        get: (t, k: string) => (k === "measureText" ? () => ({ width: 10 }) : k === "fill" ? () => seen.push(String(t.fillStyle)) : k in t ? t[k] : () => {}),
        set: (t, k: string, v) => { t[k] = v; return true; },
      });
      req.draw(g as never, () => null);
      return seen;
    };
    expect(fills(null)[0]).toBe("rgba(20,22,26,0.46)");
    expect(fills("#ff0000")[0]).not.toBe("rgba(20,22,26,0.46)");
    // 색 견본(마지막 채움) — DOM 처럼 색을 안 정하면 --border2(어두운 회색), 강조색이 아니다
    expect(fills(null).at(-1)).toBe("rgba(255,255,255,0.13)");
    expect(fills("#ff0000").at(-1)).toBe("#ff0000");
    // 모습 열쇠도 색 지정 여부를 담는다 — 색이 없다가 강조색으로 정해져도(같은 gc) 다시 굽는다
    const key = (color: string | null) => buildGpuScene(input({ groups: [{ id: "G", x: 0, y: 0, w: 400, h: 300, color, name: "묶음", count: 1, collapsed: false, selected: false }] }))
      .requests.find((r) => r.id === "group:G")!.key;
    expect(key(null)).not.toBe(key("#c4e84a"));
  });

  it("긴 그룹 이름은 개수 알약·오른쪽 단추와 겹치지 않게 잘린다(DOM flex 처럼 남는 폭만, 알약과 접기 칸 사이 6)", () => {
    for (const count of [1, 123]) {
      const m = buildGpuScene(input({ groups: [{ id: "G", x: 0, y: 0, w: 400, h: 300, color: null, name: "아주긴그룹이름".repeat(10), count, collapsed: false, selected: false }] }));
      const req = m.requests.find((r) => r.id === "group:G")!;
      const texts: Array<[string, number]> = [];
      const arcs: number[] = [];
      const g = new Proxy({} as Record<string, unknown>, {
        get: (t, k: string) => (k === "measureText" ? (s: string) => ({ width: s.length * 7 })
          : k === "fillText" ? (s: string, x: number) => texts.push([s, x])
            : k === "arcTo" ? (x1: number) => arcs.push(x1) : k in t ? t[k] : () => {}),
        set: (t, k: string, v) => { t[k] = v; return true; },
      });
      req.draw(g as never, () => null);
      const pillRight = Math.max(...arcs.slice(-4)); // 개수 알약의 arcTo 넷 — 가장 오른쪽 = 알약 끝
      const foldCenter = texts.find(([s]) => s === "−")![1];
      expect(pillRight).toBeLessThanOrEqual(foldCenter - 12 - 6);
    }
  });

  it("이름표·결과 수 배지·빛은 그 카드에 딸린다(owner) — 그룹 머리줄은 그룹 층(owner 없음)", () => {
    const m = buildGpuScene(input({
      cards: [{ card: gen, w: 260, h: 200 }, { card: text("t", 0), w: 260, h: 120 }], selected: new Set(["t"]), glow: new Set(["g"]), variantCount: () => 2,
      groups: [{ id: "G", x: 0, y: -40, w: 600, h: 300, color: null, name: "묶음", count: 2, collapsed: false, selected: false }],
    }));
    expect(m.quads.find((q) => q.id === "label:t")?.owner).toBe("t");
    expect(m.quads.find((q) => q.id === "multi:g")?.owner).toBe("g");
    expect(m.quads.find((q) => q.id === "group:G")?.owner).toBeUndefined();
    // 머리줄은 DOM 처럼 그룹 틀(2px) 안쪽 — 단추 자리가 DOM 실측과 맞게
    expect(m.quads.find((q) => q.id === "group:G")).toMatchObject({ x: 2, y: -38, w: 596, h: 26 });
    expect(m.rects.filter((r) => r.owner === "g")).toHaveLength(2); // 빛 두 겹
  });
});