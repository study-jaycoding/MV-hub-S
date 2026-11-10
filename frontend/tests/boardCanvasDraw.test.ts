// 판 한 장 그림판의 그릴 것 만들기·그리기(docs/status/캔버스_보드그림판_2026-11-10.md) — 기록하는 가짜 2D 문맥으로 종류별 호출을 본다.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { boardItemSources, buildBoardItem, drawBoardItem, type BoardBuildContext, type BoardItem } from "../src/lib/boardCanvasDraw";
import type { SceneCard } from "../src/lib/scenes";

const statuses = vi.hoisted(() => ({ map: {} as Record<string, string | undefined> }));
vi.mock("../src/lib/sceneAssetRelink", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  refServerStatus: (_ws: string, r: { file_path: string }) => statuses.map[r.file_path],
  refHeldInfo: () => undefined,
}));

function recorder() {
  const calls: Array<[string, ...unknown[]]> = [];
  const state: Record<string, unknown> = { fillStyle: "", strokeStyle: "", font: "", lineWidth: 1, globalAlpha: 1, textAlign: "left", textBaseline: "alphabetic" };
  const g = new Proxy(state, {
    get(target, key: string) {
      if (key === "measureText") return (s: string) => ({ width: s.length * 6 });
      if (key in target) return target[key];
      return (...args: unknown[]) => { calls.push([key, ...args]); };
    },
    set(target, key: string, value) {
      target[key] = value;
      if (key === "globalAlpha") calls.push(["alpha", value]);
      return true;
    },
  });
  return { g: g as never, calls, texts: () => calls.filter((c) => c[0] === "fillText").map((c) => String(c[1])), count: (name: string) => calls.filter((c) => c[0] === name).length };
}
const img = { naturalWidth: 100, naturalHeight: 100 } as unknown as HTMLImageElement;
const box = (id = "c") => ({ id, x: 0, y: 0, w: 260, h: 200 });
const ctx = (over: Partial<BoardBuildContext> = {}): BoardBuildContext => ({
  workspaceId: "ws", fill: true, cardsById: new Map(), resolvedEdges: [], genData: {},
  filters: { typeFilter: "all", colorFilter: new Set(), tagFilter: new Set(), sharedOnly: false, commentOnly: false, finalOnly: false } as never,
  folderSel: null, modelBlocked: () => false, waiting: () => false, genMissing: () => false, genKnown: () => true, disabled: () => false,
  hideFailed: false, lastViewedCardId: null, logo: "/logo.svg", ...over,
});
const gen = (id: string, patch: Record<string, unknown> = {}) => ({
  id, status: "done", prompt: "p", shared: false, is_final: false, is_held: false, color: null, tags: [],
  assets: [{ id: "a", generation_id: id, type: "image", file_path: `/${id}.png`, thumbnail_path: null }], ...patch,
});
const refCard = (id: string, refs: Array<Record<string, unknown>>) => ({ id, kind: "reference", x: 0, y: 0, refs }) as unknown as SceneCard;

beforeEach(() => {
  statuses.map = {};
});

describe("레퍼런스", () => {
  it("한 장 그림은 그림 주소를 쓰고, 그림이 오면 그리고 안 오면 빗금 자리표시", () => {
    const item = buildBoardItem(refCard("r", [{ type: "image", file_path: "asset:p|a.png", name: "a" }]), box("r"), ctx())!;
    expect(item).toMatchObject({ kind: "reference", single: true });
    expect(boardItemSources(item)).toHaveLength(1);
    const withImage = recorder();
    drawBoardItem(withImage.g, item, () => img);
    expect(withImage.count("drawImage")).toBe(1);
    const loading = recorder();
    drawBoardItem(loading.g, item, () => null);
    expect(loading.count("drawImage")).toBe(0);
    expect(loading.count("stroke")).toBeGreaterThan(0); // 빗금
  });

  it("영상·오디오 레퍼런스가 하나라도 있으면 그리지 않는다(DOM 몸통 — 마우스 올림 재생)", () => {
    expect(buildBoardItem(refCard("r", [{ type: "image", file_path: "asset:p|a.png" }, { type: "video", file_path: "asset:p|v.mp4" }]), box(), ctx())).toBeNull();
    expect(buildBoardItem(refCard("r", [{ type: "audio", file_path: "asset:p|s.mp3" }]), box(), ctx())).toBeNull();
  });

  it("서버에 없음은 붉은 빗금·안내 글, '이 PC 에만'은 그림 위 마크 — 그림 주소를 부르지 않는다", () => {
    statuses.map["asset:p|gone.png"] = "missing";
    statuses.map["asset:p|mine.png"] = "local";
    const gone = buildBoardItem(refCard("r", [{ type: "image", file_path: "asset:p|gone.png", name: "gone.png" }]), box(), ctx())!;
    expect(boardItemSources(gone)).toEqual([]);
    const r = recorder();
    drawBoardItem(r.g, gone, () => img);
    expect(r.texts()).toEqual(expect.arrayContaining(["서버에 없음", "gone.png"]));
    const mine = buildBoardItem(refCard("r", [{ type: "image", file_path: "asset:p|mine.png" }]), box(), ctx())!;
    const m = recorder();
    drawBoardItem(m.g, mine, () => img);
    expect(m.calls.some((c) => c[0] === "stroke" && m.calls.indexOf(c) > m.calls.findIndex((x) => x[0] === "drawImage"))).toBe(true); // 그림 뒤에 마크
  });

  it("여러 장은 3열 격자로 장마다 그린다", () => {
    const item = buildBoardItem(refCard("r", [1, 2, 3, 4].map((n) => ({ type: "image", file_path: `asset:p|${n}.png` }))), box(), ctx())!;
    expect(item).toMatchObject({ single: false });
    const r = recorder();
    drawBoardItem(r.g, item, () => img);
    expect(r.count("drawImage")).toBe(4);
  });
});

describe("글·모델", () => {
  it("글은 줄바꿈해 그리고 @토큰은 테두리 있는 알약", () => {
    const item = buildBoardItem({ id: "t", kind: "text", x: 0, y: 0, text: "hello @image2 world" } as SceneCard, box(), ctx())!;
    const r = recorder();
    drawBoardItem(r.g, item, () => null);
    expect(r.texts()).toEqual(expect.arrayContaining(["hello", "@image2", "world"]));
    expect(r.count("stroke")).toBeGreaterThan(0);
  });

  it("모델은 이름·종류·옵션 줄, 쓸 수 없는 모델은 '사용 불가', 설정 전은 '모델 설정'", () => {
    const card = { id: "m", kind: "model", x: 0, y: 0, modelCfg: { model: "seedance", modelName: "Seedance 2.5", type: "video", params: { aspect_ratio: "16:9" } } } as unknown as SceneCard;
    const r = recorder();
    drawBoardItem(r.g, buildBoardItem(card, box(), ctx({ modelBlocked: () => true }))!, () => null);
    expect(r.texts()).toEqual(expect.arrayContaining(["Seedance 2.5", "VIDEO", "사용 불가"]));
    expect(r.texts().length).toBeGreaterThanOrEqual(5); // 옵션 라벨·값
    const empty = recorder();
    drawBoardItem(empty.g, buildBoardItem({ id: "m", kind: "model", x: 0, y: 0 } as SceneCard, box(), ctx())!, () => null);
    expect(empty.texts()).toEqual(["모델 설정"]);
  });
});

describe("리스트", () => {
  it("레퍼런스를 모은 리스트는 대표 썸네일 격자·장수 배지, 빈 리스트는 안내 두 줄", () => {
    const cards = new Map<string, SceneCard>([
      ["r1", refCard("r1", [{ type: "image", file_path: "asset:p|1.png" }, { type: "image", file_path: "asset:p|2.png" }])],
      ["r2", refCard("r2", [{ type: "image", file_path: "asset:p|3.png" }])],
      ["L", { id: "L", kind: "list", x: 0, y: 0 } as SceneCard],
    ]);
    const edges = [{ id: "e1", from: "r1", to: "L" }, { id: "e2", from: "r2", to: "L" }] as never;
    const item = buildBoardItem(cards.get("L")!, box("L"), ctx({ cardsById: cards, resolvedEdges: edges }))!;
    expect(item).toMatchObject({ kind: "list", mode: "thumbs" });
    const r = recorder();
    drawBoardItem(r.g, item, () => img);
    expect(r.count("drawImage")).toBe(2);
    expect(r.texts()).toContain("2"); // 장수 배지
    const empty = recorder();
    drawBoardItem(empty.g, buildBoardItem({ id: "E", kind: "list", x: 0, y: 0 } as SceneCard, box("E"), ctx({ cardsById: new Map() }))!, () => null);
    expect(empty.texts()).toEqual(["생성/텍스트/레퍼런스", "노드 연결"]);
  });
});

describe("생성", () => {
  const card = (patch: Record<string, unknown> = {}) => ({ id: "g", kind: "generation", x: 0, y: 0, ...patch }) as unknown as SceneCard;
  const state = (c: SceneCard, over: Partial<BoardBuildContext> = {}) => (buildBoardItem(c, box("g"), ctx(over)) as (BoardItem & { state?: string }) | null)?.state ?? null;

  it("GenerationCard 와 같은 갈래 — 빈 카드·대기·삭제됨·실패·답 전·생성 중·완료", () => {
    expect(state(card())).toBe("empty");
    expect(state(card({ genId: "x" }), { waiting: () => true })).toBe("loading");
    expect(state(card({ genId: "x" }), { genMissing: () => true })).toBe("deleted");
    expect(state(card({ genId: "x" }), { genData: { x: gen("x", { status: "failed" }) } as never })).toBe("fail");
    expect(state(card({ genId: "x" }), { genKnown: () => false })).toBe("blank");
    expect(state(card({ genId: "x" }), { genData: { x: gen("x", { status: "running" }) } as never })).toBe("loading");
    expect(state(card({ genId: "x" }), { genData: { x: gen("x") } as never })).toBe("done");
  });

  it("완료는 결과 그림·S 배지·색 띠, 필터에 안 맞으면 흐리게(0.12) — 영상·비활성·마지막 열람 카드는 그리지 않는다", () => {
    const item = buildBoardItem(card({ genId: "x" }), box("g"), ctx({ genData: { x: gen("x", { shared: true, color: "#ff0000" }) } as never }))!;
    expect(boardItemSources(item)).toHaveLength(1);
    const r = recorder();
    drawBoardItem(r.g, item, () => img);
    expect(r.count("drawImage")).toBe(1);
    expect(r.texts()).toContain("S");
    expect(r.calls.some((c) => c[0] === "fillRect" && c[4] === 9)).toBe(true); // 색 띠 9px
    const dim = buildBoardItem(card({ genId: "x" }), box("g"), ctx({ genData: { x: gen("x") } as never, filters: { typeFilter: "video", colorFilter: new Set(), tagFilter: new Set(), sharedOnly: false, commentOnly: false, finalOnly: false } as never }))!;
    const d = recorder();
    drawBoardItem(d.g, dim, () => img);
    expect(d.calls).toContainEqual(["alpha", 0.12]);
    expect(buildBoardItem(card({ genId: "x" }), box("g"), ctx({ genData: { x: gen("x", { assets: [{ type: "video", file_path: "/v.mp4" }] }) } as never }))).toBeNull();
    expect(buildBoardItem(card({ genId: "x" }), box("g"), ctx({ genData: { x: gen("x") } as never, disabled: () => true }))).toBeNull();
    expect(buildBoardItem(card({ genId: "x" }), box("g"), ctx({ genData: { x: gen("x") } as never, lastViewedCardId: "g" }))).toBeNull();
  });

  it("실패는 상태 글(실패 숨김이면 흐리게), 생성 중·빈 카드는 로고 주소를 쓴다", () => {
    const fail = buildBoardItem(card({ genId: "x" }), box("g"), ctx({ genData: { x: gen("x", { status: "failed" }) } as never, hideFailed: true }))!;
    const r = recorder();
    drawBoardItem(r.g, fail, () => null);
    expect(r.calls).toContainEqual(["alpha", 0.12]);
    expect(r.texts().length).toBe(1);
    expect(boardItemSources(buildBoardItem(card(), box("g"), ctx())!)).toEqual(["/logo.svg"]);
  });
});
