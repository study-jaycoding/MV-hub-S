// 어셋 탭 Masonry(Jay 2026-10-30 — "이미지2(Masonry)가 어셋탭에 없네 넣어줘") · 보기·정렬 아이콘 정중앙.
//  기록: docs/status/어셋_Masonry_아이콘정렬_2026-10-30.md
//  · 줄 계산(lib/assetVirtualRows) — 워크스페이스(lib/gridVirtualRows)와 같은 줄 맞춤 · 화면 쪽은 tests/assetFolderTabs.test.tsx
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { describe, expect, it } from "vitest";
import { buildAssetRows } from "../src/lib/assetVirtualRows";
import { navigateGrid } from "../src/lib/gridVirtualRows";
import type { AssetNode } from "../src/types";

const file = (name: string, mtime = 0): AssetNode => ({ name, path: `assets/${name}`, type: "image", mtime } as AssetNode);
const ratioBy: Record<string, number> = {};
const justify = (width: number, targetHeight: number, gap: number) => ({ width, targetHeight, gap, ratioOf: (f: AssetNode) => ratioBy[f.name] ?? 1 });

describe("어셋 Masonry 줄 계산", () => {
  it("폭을 넘기는 순간 끊고 줄 폭이 꽉 차게 높이를 줄인다 · 끝난 줄은 목표 높이 · Square(justify 없음)는 그대로", () => {
    const files = ["a", "b", "c", "d"].map((n) => file(n));
    Object.assign(ratioBy, { a: 16 / 9, b: 1, c: 9 / 16, d: 2 });
    const model = buildAssetRows(files, 3, false, justify(400, 170, 4));
    const cards = model.rows.filter((row) => row.type === "cards");
    expect(cards.map((row) => row.idxs)).toEqual([[0, 1], [2, 3], ]);
    expect(cards[0].height).toBeCloseTo(396 / (16 / 9 + 1));
    expect(cards[0].widths!.reduce((s, w) => s + w, 0) + 4).toBeCloseTo(400);
    expect(cards[1].height).toBeCloseTo(396 / (9 / 16 + 2)); // c(95.6) + d(340) + 4 ≥ 400 — 이 줄도 꽉 찬다
    const tail = buildAssetRows([...files, file("e")], 3, false, justify(400, 170, 4)).rows.at(-1);
    expect(tail && tail.type === "cards" && [tail.idxs, tail.height]).toEqual([[4], 170]); // 끝난 줄 — 늘리지 않는다
    const square = buildAssetRows(files, 3, false);
    expect([square.rows.map((row) => row.type === "cards" && row.idxs), square.navCenters]).toEqual([[[0, 1, 2], [3]], undefined]);
  });

  it("날짜가 바뀌면 그 줄은 목표 높이로 끝난다 · 위·아래 = 가로로 가장 가까운 칸", () => {
    const day = 86400;
    const files = [file("a", 2 * day), file("b", 2 * day), file("c", day)];
    const model = buildAssetRows(files, 3, true, justify(1000, 100, 0));
    expect(model.rows.map((row) => row.type === "header" ? "h" : [row.idxs, row.height])).toEqual(["h", [[0, 1], 100], "h", [[2], 100]]);
    // 1줄 = 넓은 A(8) · B(3) / 2줄 = 정사각 열 장 — B(가운데 863.6) 아래 = 850 의 칸(9번째 = 인덱스 10)
    const wide = ["A", "B", ...Array.from({ length: 10 }, (_, i) => `s${i}`)].map((n) => file(n));
    Object.assign(ratioBy, { A: 8, B: 3 });
    const m2 = buildAssetRows(wide, 3, false, justify(1000, 100, 0));
    expect(navigateGrid({ navGrid: m2.navGrid, posByGen: m2.posByIdx, navCenters: m2.navCenters }, 1, "ArrowDown")).toBe(10);
  });

  it("어셋 툴바의 보기·정렬 단추 아이콘은 정중앙 — 어셋 .af-btn 좌우 여백을 0 으로 이긴다(CSS)", () => {
    const css = readFileSync(new NodeURL("../src/styles/generations.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.assets-tools \.af-btn\.vp-btn \{ padding: 0;/);
    const assets = readFileSync(new NodeURL("../src/styles/assets.css", import.meta.url), "utf8");
    expect(assets).toContain(".assets-masonry .asset-cell.masonry .asset-media { flex: 1 1 auto; min-height: 0; height: auto; padding-bottom: 0; }");
  });
});
