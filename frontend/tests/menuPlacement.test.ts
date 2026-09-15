// 떠 있는 메뉴가 잘림 경계 안에 들어가는지 — 코덱스 실측값(2026-09-15)을 그대로 넣어 못 박는다.
import { describe, expect, it } from "vitest";
import { computeMenuPlacement, intersectRect, type PlacementInput } from "../src/lib/menuPlacement";

// 640x400 '폴더 보기' 창에서 실제로 잰 형태 — 창이 짧아 위로 79px 잘렸던 상황.
const base: PlacementInput = {
  anchor: { top: 300, bottom: 332, left: 120, right: 260 },
  bounds: { top: 53, bottom: 360, left: 20, right: 620 },
  origin: { top: 300, bottom: 332, left: 120, right: 260 },
  content: { height: 320, width: 180 },
  prefer: "up",
  gap: 6,
};

describe("메뉴 배치 계산", () => {
  it("선호 방향에 다 들어가면 그대로 위로 연다", () => {
    const p = computeMenuPlacement({
      ...base,
      // 단추가 아래쪽에 있어 위로 320px 가 들어간다(400 - 0 - 6 = 394).
      anchor: { ...base.anchor, top: 400, bottom: 432 },
      origin: { ...base.origin, top: 400, bottom: 432 },
      bounds: { top: 0, bottom: 900, left: 0, right: 1200 },
    });
    expect(p.direction).toBe("up");
    expect(p.maxHeight).toBe(320); // 상한 그대로
    expect(p.top).toBeNull();
    expect(p.bottom).not.toBeNull();
  });

  it("위가 모자라면 높이를 줄여 경계 안에 넣는다 (코덱스 실측 303.4px)", () => {
    const p = computeMenuPlacement({
      ...base,
      anchor: { ...base.anchor, top: 362.406, bottom: 394.406 },
      bounds: { ...base.bounds, top: 53, bottom: 400 },
    });
    expect(p.direction).toBe("up");
    // 362.406 - 53 - 6 = 303.406 → 320 이 아니라 여기에 맞춰야 한다
    expect(p.maxHeight).toBeCloseTo(303.406, 2);
  });

  it("위가 아주 모자라고 아래가 넉넉하면 아래로 뒤집는다", () => {
    const p = computeMenuPlacement({
      ...base,
      anchor: { ...base.anchor, top: 80, bottom: 112 },
      bounds: { top: 53, bottom: 800, left: 20, right: 620 },
    });
    expect(p.direction).toBe("down");
    expect(p.maxHeight).toBe(320);
    expect(p.bottom).toBeNull();
    expect(p.top).not.toBeNull();
  });

  it("양쪽 다 모자라면 넓은 쪽을 고르고 높이를 제한한다", () => {
    const p = computeMenuPlacement({
      ...base,
      anchor: { ...base.anchor, top: 150, bottom: 182 },
      bounds: { top: 100, bottom: 250, left: 20, right: 620 },
    });
    // 위 44 / 아래 62 → 아래가 넓다
    expect(p.direction).toBe("down");
    expect(p.maxHeight).toBe(62);
  });

  it("가까운 조상 안이어도 바깥 조상이 더 좁으면 그쪽을 따른다", () => {
    const near = { top: 53, bottom: 400, left: 20, right: 620 };
    const outer = { top: 200, bottom: 400, left: 20, right: 620 };
    const p = computeMenuPlacement({
      ...base,
      anchor: { ...base.anchor, top: 362, bottom: 394 },
      bounds: intersectRect(near, outer),
    });
    expect(p.maxHeight).toBe(362 - 200 - 6);
  });

  it("오른쪽으로 넘치면 왼쪽으로 당긴다 (코덱스 실측 33.8px 넘침)", () => {
    const p = computeMenuPlacement({
      ...base,
      origin: { top: 300, bottom: 332, left: 470, right: 610 },
      anchor: { top: 300, bottom: 332, left: 470, right: 610 },
      bounds: { top: 0, bottom: 600, left: 20, right: 480 },
      content: { height: 320, width: 180 },
    });
    // 경계 오른쪽 480 - 폭 180 = 300 → origin(470) 기준 -170
    expect(p.left).toBe(300 - 470);
    expect(p.maxWidth).toBe(180);
  });

  it("왼쪽으로 넘쳐도 경계 안으로 민다", () => {
    const p = computeMenuPlacement({
      ...base,
      origin: { top: 300, bottom: 332, left: -40, right: 100 },
      anchor: { top: 300, bottom: 332, left: -40, right: 100 },
      bounds: { top: 0, bottom: 600, left: 0, right: 480 },
    });
    expect(p.left).toBe(0 - -40);
  });

  it("경계가 메뉴보다 좁으면 폭 자체를 줄인다", () => {
    const p = computeMenuPlacement({
      ...base,
      bounds: { top: 0, bottom: 600, left: 100, right: 220 },
      content: { height: 320, width: 180 },
    });
    expect(p.maxWidth).toBe(120);
  });

  it("가용 공간이 0 이하여도 음수 크기를 내지 않는다", () => {
    const p = computeMenuPlacement({
      ...base,
      anchor: { top: 50, bottom: 60, left: 120, right: 260 },
      bounds: { top: 50, bottom: 60, left: 120, right: 260 },
    });
    expect(p.maxHeight).toBeGreaterThanOrEqual(0);
    expect(p.maxWidth).toBeGreaterThanOrEqual(0);
  });

  it("방향 판정에는 '내용이 원하는 높이'를 쓴다 — 줄어든 높이를 되먹이지 않는다", () => {
    // 위 303.4 / 아래 200. 내용 320 은 양쪽 다 안 들어가지만 위가 더 넓다.
    const input: PlacementInput = {
      ...base,
      anchor: { ...base.anchor, top: 362.406, bottom: 394.406 },
      bounds: { top: 53, bottom: 600.406, left: 20, right: 620 },
    };
    const first = computeMenuPlacement(input);
    // 한 번 제한된 높이(303.406)를 다시 넣어도 방향이 흔들리면 안 된다
    const again = computeMenuPlacement({ ...input, content: { ...input.content, height: first.maxHeight } });
    expect(again.direction).toBe(first.direction);
  });
});

describe("경계 교집합", () => {
  it("겹치지 않으면 넓이 0 을 준다 — 음수가 나오면 안 된다", () => {
    const r = intersectRect({ top: 0, bottom: 10, left: 0, right: 10 },
                            { top: 50, bottom: 60, left: 50, right: 60 });
    expect(r.bottom - r.top).toBe(0);
    expect(r.right - r.left).toBe(0);
  });
});
