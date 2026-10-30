// @vitest-environment jsdom
// 워크스페이스 그리드 Layout: Square · Masonry(Jay 2026-10-30 — "이 전체 보기에서 마우스 우클릭을 하면 지금처럼 스퀘어로 카드가 보이던지
//  이미지2처럼 보이던지 정하는게 나오면 좋겠다" → 모의 그림 → "이대로 만들어"). 기록: docs/status/그리드_Masonry_2026-10-30.md
//  · 줄 계산(lib/gridVirtualRows) — 폭을 넘기는 순간 줄을 끊고 꽉 차게 높이를 줄인다 · 끝난 줄은 목표 높이 · 위아래 = 가로로 가장 가까운 카드
//  · 자리마다 기억(placeViews) · 격자(ThumbnailGrid)가 칸을 비율대로 그리고 잰 비율로 다시 짠다
//  · Layout 을 고르는 곳 = 툴바 보기 단추 창(tests/toolbarPopovers.test.tsx — 처음의 '전체 보기 단추 우클릭 메뉴'를 같은 날 대신했다)
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThumbnailGrid } from "../src/components/ThumbnailGrid";
import { buildGridRows, navigateGrid, paramAspectRatio, type JustifyOptions } from "../src/lib/gridVirtualRows";
import { parsePlaceViews, withPlaceView } from "../src/lib/placeViews";
import type { Generation } from "../src/types";

vi.mock("virtua", async () => {
  const { forwardRef, useImperativeHandle } = await import("react");
  return { Virtualizer: forwardRef((props: { data: unknown[]; children: (row: unknown) => React.ReactNode }, ref) => {
    useImperativeHandle(ref, () => ({ scrollToIndex: () => {} }));
    return <>{props.data.map(props.children)}</>;
  }) };
});
vi.mock("../src/api", () => ({ api: { thumbOrRaw: (path: string) => path, mediaUrl: (path: string) => path } }));
vi.mock("../src/lib/useGenerationViewsSynced", () => ({ useGenerationViewsSynced: () => ({ card: {}, asset: {} }) }));
vi.mock("../src/lib/modelCatalog", () => ({ useModelDisplayName: () => (name: string) => name }));
vi.mock("../src/lib/i18n", () => ({ t: (value: string) => value, useT: () => (value: string) => value }));
vi.mock("../src/components/MediaThumbnail", () => ({ MediaThumbnail: () => <span>thumbnail</span> }));

const gen = (id: string, aspect?: string, day = "2026-10-01"): Generation => ({
  id, model: "test", prompt: "test", status: "done", created_at: `${day}T12:00:00Z`,
  assets: [{ id: `asset-${id}`, type: "image", file_path: `/test/${id}.png` }],
  tags: [], auto_tags: [], references: [], shared: false, is_mine: true, params: aspect ? { aspect_ratio: aspect } : {},
}) as unknown as Generation;
const ratioById: Record<string, number> = {};
const justify = (width: number, targetHeight: number, gap: number): JustifyOptions => ({ width, targetHeight, gap, ratioOf: (g) => ratioById[g.id] ?? 1 });
const dayOf = (iso: string) => ({ key: iso.slice(0, 10), label: iso.slice(0, 10) });

describe("Masonry 줄 계산(lib/gridVirtualRows)", () => {
  it("비율 읽기 — 16:9 · 9x16 · 소수. auto·없음·0 은 null", () => {
    expect(paramAspectRatio({ aspect_ratio: "16:9" })).toBeCloseTo(16 / 9);
    expect(paramAspectRatio({ aspect_ratio: "9x16" })).toBeCloseTo(9 / 16);
    expect(paramAspectRatio({ aspect_ratio: "2.39:1" })).toBeCloseTo(2.39);
    for (const params of [{ aspect_ratio: "auto" }, {}, null, { aspect_ratio: "0:1" }, { aspect_ratio: 1.5 }]) expect(paramAspectRatio(params)).toBeNull();
  });

  it("폭을 넘기는 순간 줄을 끊고 줄 폭이 꽉 차게 높이를 줄인다(목표 이하) · 끝난 줄은 목표 높이 · 격자 위치는 Square 와 같은 규칙", () => {
    const list = ["a", "b", "c", "d", "e", "f"].map((id) => gen(id));
    Object.assign(ratioById, { a: 16 / 9, b: 1, c: 9 / 16, d: 16 / 9, e: 4 / 3, f: 1 });
    const model = buildGridRows(list, 3, false, undefined, justify(1000, 170, 4));
    const cards = model.rows.filter((row) => row.type === "cards");
    expect(cards.map((row) => row.items.map((g) => g.id))).toEqual([["a", "b", "c", "d", "e"], ["f"]]);
    const [full, last] = cards;
    const ratioSum = 16 / 9 + 1 + 9 / 16 + 16 / 9 + 4 / 3;
    expect(full.height).toBeCloseTo((1000 - 4 * 4) / ratioSum);
    expect(full.height!).toBeLessThan(170);
    expect(full.widths!.reduce((sum, width) => sum + width, 0) + 4 * 4).toBeCloseTo(1000); // 꽉 찬다
    expect([last.height, last.widths]).toEqual([170, [170]]); // 늘리지 않는다
    list.forEach((_, index) => {
      const pos = model.posByGen[index];
      expect(model.navGrid[pos.navRow][pos.col]).toBe(index);
    });
    expect(model.rowIndexOfNavRow).toEqual([0, 1]);
    // Square(justify 없음)는 그대로 — 높이·폭·가운데 자리가 없다
    const square = buildGridRows(list, 3, false);
    expect(square.rows.map((row) => row.type === "cards" && [row.items.length, row.height, row.widths])).toEqual([[3, undefined, undefined], [3, undefined, undefined]]);
    expect(square.navCenters).toBeUndefined();
  });

  it("날짜가 바뀌면 그 줄은 목표 높이로 끝나고 머리 줄이 들어간다 · 날짜 묶음은 그대로", () => {
    const list = [gen("a", undefined, "2026-10-02"), gen("b", undefined, "2026-10-02"), gen("c", undefined, "2026-10-01")];
    Object.assign(ratioById, { a: 1, b: 1, c: 1 });
    const model = buildGridRows(list, 3, true, dayOf, justify(1000, 100, 4));
    expect(model.rows.map((row) => row.type === "header" ? row.dayKey : [row.items.map((g) => g.id), row.height]))
      .toEqual(["2026-10-02", [["a", "b"], 100], "2026-10-01", [["c"], 100]]);
    expect([...model.dateGroups!.entries()].map(([day, group]) => [day, group.ids])).toEqual([["2026-10-02", ["a", "b"]], ["2026-10-01", ["c"]]]);
  });

  it("위·아래는 열 번호가 아니라 가로로 가장 가까운 카드로 간다(줄마다 칸이 다르다)", () => {
    // 1줄 = 넓은 A(8) · B(3) → 높이 1000/11 · 가운데 363.6 · 863.6 / 2줄 = 정사각 열 장(가운데 50, 150, …, 950)
    const ids = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"];
    const list = ids.map((id) => gen(id));
    Object.assign(ratioById, Object.fromEntries(ids.map((id) => [id, id === "A" ? 8 : id === "B" ? 3 : 1])));
    const model = buildGridRows(list, 3, false, undefined, justify(1000, 100, 0));
    expect(model.navGrid.map((row) => row.length)).toEqual([2, 10]);
    const to = (from: string, key: string) => ids[navigateGrid(model, ids.indexOf(from), key) ?? -1];
    expect(to("B", "ArrowDown")).toBe("K"); // 가운데 863.6 → 850(K) · 열 번호(1)로 가면 D 였다
    expect(to("A", "ArrowDown")).toBe("F");
    expect(to("L", "ArrowUp")).toBe("B");
    expect(to("C", "ArrowUp")).toBe("A");
    expect([to("A", "ArrowRight"), to("B", "ArrowLeft"), to("C", "ArrowDown")]).toEqual(["B", "A", undefined]);
  });
});

describe("자리마다 기억(placeViews)", () => {
  it("masonry 는 참·거짓만 읽고 다른 설정과 함께 적힌다", () => {
    expect(parsePlaceViews({ a: { layout: "grid", masonry: true }, b: { layout: "grid", masonry: "yes" } }))
      .toEqual({ a: { layout: "grid", group: false, masonry: true }, b: { layout: "grid", group: false } });
    const views = withPlaceView({ a: { layout: "grid", group: false, fill: false } }, "a", { layout: "grid", group: false, masonry: true });
    expect(views.a).toEqual({ layout: "grid", group: false, fill: false, masonry: true });
  });
});

let host: HTMLDivElement;
let root: Root;
let frames: Map<number, FrameRequestCallback>;
let frameId: number;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  frames = new Map(); frameId = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  HTMLElement.prototype.scrollTo = vi.fn();
  host = document.createElement("div"); document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});
const flushFrames = () => act(() => { const pending = [...frames.values()]; frames.clear(); pending.forEach((callback) => callback(0)); });

describe("격자(ThumbnailGrid) — Masonry 칸", () => {
  const noop = () => {};
  // 폭 400 · 목표 170 · 간격 4 — g1(16:9)+g2(1:1) 이 한 줄, g3(9:16)+g4(설정 비율 없음 → 1)+g5(21:9) 가 한 줄
  const list = [gen("g1", "16:9"), gen("g2", "1:1"), gen("g3", "9:16"), gen("g4"), gen("g5", "21:9")];
  const draw = (masonry: boolean) => act(() => root.render(
    <ThumbnailGrid generations={list} tab="my" scale={1} fill layout="grid" masonry={masonry} groupByDate={false}
      selectedIds={new Set()} onSelectedChange={noop} onToggleSelect={noop} onSetSource={noop} onSetTags={noop} onOpenComments={noop}
      onRegenerate={noop} onPublish={noop} onUnpublish={noop} onFinalize={noop} onUnfinalize={noop} onImport={noop} onRestore={noop}
      dimDeleted={false} onInfo={noop} onPreview={noop} />,
  ));
  const rowsShown = () => [...host.querySelectorAll<HTMLElement>(".gen-vrow-masonry")].map((row) =>
    [...row.querySelectorAll<HTMLElement>(".gen-cell")].map((cell) => [cell.dataset.id, Math.round(parseFloat(cell.style.width)), Math.round(parseFloat(cell.style.height))]));

  it("칸 = 줄 높이 × 그림 비율 · 썸네일이 뜨면 잰 비율로 다시 짠다 · Square 는 지금 그대로", () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(400);
    draw(false);
    expect([host.querySelectorAll(".gen-vrow-grid").length, host.querySelector(".gen-vrow-masonry")]).toEqual([3, null]); // (400 + 12) / (180 + 12) = 2열 → 다섯 장은 세 줄
    draw(true);
    const h1 = 396 / (16 / 9 + 1), h2 = 392 / (9 / 16 + 1 + 21 / 9);
    expect(rowsShown()).toEqual([
      [["g1", Math.round(h1 * 16 / 9), Math.round(h1)], ["g2", Math.round(h1), Math.round(h1)]],
      [["g3", Math.round(h2 * 9 / 16), Math.round(h2)], ["g4", Math.round(h2), Math.round(h2)], ["g5", Math.round(h2 * 21 / 9), Math.round(h2)]],
    ]);
    // g4 의 썸네일이 2:1 로 떴다 — load 는 올라오지 않는다(격자가 잡기 단계로 듣는다)
    const img = document.createElement("img");
    Object.defineProperties(img, { naturalWidth: { value: 400 }, naturalHeight: { value: 200 } });
    host.querySelector('.gen-cell[data-id="g4"]')!.appendChild(img);
    act(() => { img.dispatchEvent(new Event("load")); });
    flushFrames();
    const h3 = 396 / (9 / 16 + 2);
    expect(rowsShown()).toEqual([
      [["g1", Math.round(h1 * 16 / 9), Math.round(h1)], ["g2", Math.round(h1), Math.round(h1)]],
      [["g3", Math.round(h3 * 9 / 16), Math.round(h3)], ["g4", Math.round(h3 * 2), Math.round(h3)]],
      [["g5", Math.round(170 * 21 / 9), 170]], // 끝난 줄 — 목표 높이
    ]);
    // 설정 비율이 있는 카드는 잰 값보다 설정이 앞선다(다시 짜지 않는다)
    const other = document.createElement("img");
    Object.defineProperties(other, { naturalWidth: { value: 100 }, naturalHeight: { value: 400 } });
    host.querySelector('.gen-cell[data-id="g1"]')!.appendChild(other);
    act(() => { other.dispatchEvent(new Event("load")); });
    expect(frames.size).toBe(0);
  });
});
