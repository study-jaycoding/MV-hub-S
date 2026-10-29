// 무선 짝 화살표(Jay 2026-10-29) — INPUT 하나를 고르면 그 INPUT 이 고른 OUTPUT, OUTPUT 하나를 고르면 그 OUTPUT 을 고른 INPUT 들.
//  화살표는 두 카드 테두리 밖에서 시작·끝나고(화살촉이 카드에 가려지지 않게), 짝이 화면 밖이면 꼬리표에 방향 글자를 단다.
import { describe, expect, it } from "vitest";
import { rectOutsideView, viewDirectionArrow, wireTracePairs, wireTracePath } from "../src/lib/sceneEdges";
import type { SceneCard } from "../src/lib/scenes";

const cards: SceneCard[] = [
  { id: "out", kind: "output", x: 0, y: 0, text: "ref_img" },
  { id: "in1", kind: "input", x: 0, y: 300, channel: "out" },
  { id: "in2", kind: "input", x: 400, y: 300, channel: "out" },
  { id: "in3", kind: "input", x: 800, y: 300, channel: "other" },
  { id: "in4", kind: "input", x: 800, y: 300 },
  { id: "gone", kind: "input", x: 0, y: 0, channel: "deleted" },
  { id: "text", kind: "text", x: 0, y: 0, channel: "out" },
];
const byId = new Map(cards.map((c) => [c.id, c]));

describe("wireTracePairs", () => {
  it("INPUT → 고른 OUTPUT 하나 · OUTPUT → 그것을 고른 INPUT 들(다른 채널·채널 없음은 빠짐)", () => {
    expect(wireTracePairs("in1", cards, byId)).toEqual([["in1", "out"]]);
    expect(wireTracePairs("out", cards, byId)).toEqual([["out", "in1"], ["out", "in2"]]);
  });
  it("채널 없음·사라진 OUTPUT·다른 종류 카드·없는 카드는 짝 없음", () => {
    expect(wireTracePairs("in4", cards, byId)).toEqual([]);
    expect(wireTracePairs("gone", cards, byId)).toEqual([]);
    expect(wireTracePairs("in3", cards, byId)).toEqual([]); // "other" 는 없는 카드
    expect(wireTracePairs("text", cards, byId)).toEqual([]);
    expect(wireTracePairs("nope", cards, byId)).toEqual([]);
  });
});

describe("wireTracePath", () => {
  const nums = (d: string) => d.replace(/[MQ]/g, "").trim().split(/\s+/).map(Number);
  it("두 카드 테두리 밖(6px)에서 시작해 짝 테두리 밖에서 끝난다", () => {
    const a = { x: 0, y: 0, w: 150, h: 60 };
    const b = { x: 0, y: 300, w: 150, h: 60 };
    const [sx, sy, , , ex, ey] = nums(wireTracePath(a, b));
    expect([sx, sy]).toEqual([75, 66]); // a 아래 테두리(60) + 6
    expect([ex, ey]).toEqual([75, 294]); // b 위 테두리(300) − 6 — 화살촉이 짝 카드 바로 앞
  });
  it("가로·대각선도 테두리에서 끊긴다 · 겹친 카드는 그리지 않는다", () => {
    const [sx, , , , ex] = nums(wireTracePath({ x: 0, y: 0, w: 100, h: 40 }, { x: 400, y: 0, w: 100, h: 40 }));
    expect(sx).toBe(106);
    expect(ex).toBe(394);
    expect(wireTracePath({ x: 0, y: 0, w: 100, h: 40 }, { x: 20, y: 10, w: 100, h: 40 })).toBe("");
    expect(wireTracePath({ x: 0, y: 0, w: 100, h: 40 }, { x: 0, y: 0, w: 100, h: 40 })).toBe("");
  });
});

describe("화면 밖 꼬리표", () => {
  const view = { l: 0, t: 0, r: 1000, b: 600 };
  it("조금이라도 걸치면 화면 안", () => {
    expect(rectOutsideView({ x: 990, y: 100, w: 150, h: 60 }, view)).toBe(false);
    expect(rectOutsideView({ x: 1010, y: 100, w: 150, h: 60 }, view)).toBe(true);
    expect(rectOutsideView({ x: 100, y: -100, w: 150, h: 60 }, view)).toBe(true);
  });
  it("화면 가운데에서 본 8방향 글자(아래가 +y)", () => {
    const at = (x: number, y: number) => viewDirectionArrow({ x: x - 5, y: y - 5, w: 10, h: 10 }, view);
    expect([at(2000, 300), at(-900, 300), at(500, -900), at(500, 2000)]).toEqual(["→", "←", "↑", "↓"]);
    expect([at(1500, -700), at(-500, -700), at(1500, 1300), at(-500, 1300)]).toEqual(["↗", "↖", "↘", "↙"]);
  });
});
