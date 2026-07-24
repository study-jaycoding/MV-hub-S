import { describe, it, expect } from "vitest";
import { arrangeNodes } from "../src/lib/sceneLayout";
import type { LayoutNode, LayoutLink } from "../src/lib/sceneLayout";

const N = (id: string, x: number, y: number): LayoutNode => ({ id, x, y, w: 150, h: 100 });

describe("arrangeNodes", () => {
  it("연결 체인 A→B→C 는 왼→오른쪽 세 열로 배치(x 증가)", () => {
    const nodes = [N("a", 300, 10), N("b", 0, 200), N("c", 90, 400)];
    const links: LayoutLink[] = [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ];
    const pos = arrangeNodes(nodes, links);
    expect(pos.a.x).toBeLessThan(pos.b.x);
    expect(pos.b.x).toBeLessThan(pos.c.x);
  });

  it("같은 열 노드는 현재 y 순서를 보존", () => {
    // 두 소스(a,c)는 같은 열(깊이 0). y 는 c<a 이므로 정렬 후에도 c 가 a 보다 위.
    const nodes = [N("a", 0, 300), N("c", 0, 50)];
    const pos = arrangeNodes(nodes, []);
    expect(pos.c.y).toBeLessThan(pos.a.y);
  });

  it("세로로 겹치는(가로 나란) 카드는 같은 행에 윗변 맞춰 정렬(같은 y, x 증가)", () => {
    // y=0,30,80(h=100)은 세로로 겹침 → 한 행. 예전엔 세로로 collapse 됐지만 이제 행에 맞춰 가로 배치.
    const nodes = [N("a", 10, 0), N("b", 500, 30), N("c", 900, 80)];
    const pos = arrangeNodes(nodes, []);
    expect(pos.a.y).toBe(pos.b.y);
    expect(pos.b.y).toBe(pos.c.y);
    expect(pos.a.x).toBeLessThan(pos.b.x);
    expect(pos.b.x).toBeLessThan(pos.c.x);
  });

  it("2D 격자: 같은 행(겹침) 카드는 같은 y, 아랫 행은 그 아래로", () => {
    const nodes: LayoutNode[] = [
      { id: "tl", x: 0, y: 0, w: 150, h: 120 },
      { id: "tr", x: 300, y: 10, w: 150, h: 120 }, // 위 행과 세로 겹침 → 같은 행
      { id: "bl", x: 0, y: 300, w: 150, h: 120 }, // 겹치지 않음 → 아래 행
    ];
    const pos = arrangeNodes(nodes, []);
    expect(pos.tl.y).toBe(pos.tr.y);
    expect(pos.tl.x).toBeLessThan(pos.tr.x);
    expect(pos.bl.y).toBeGreaterThan(pos.tl.y);
    expect(pos.bl.x).toBe(pos.tl.x);
  });

  it("좌표는 격자(22)에 스냅", () => {
    const pos = arrangeNodes([N("a", 7, 13), N("b", 200, 500)], [{ from: "a", to: "b" }]);
    for (const id of ["a", "b"]) {
      expect(pos[id].x % 22).toBe(0);
      expect(pos[id].y % 22).toBe(0);
    }
  });

  it("사이클이 있어도 무한루프 없이 반환", () => {
    const nodes = [N("a", 0, 0), N("b", 100, 0)];
    const links: LayoutLink[] = [
      { from: "a", to: "b" },
      { from: "b", to: "a" },
    ];
    const pos = arrangeNodes(nodes, links);
    expect(Object.keys(pos).sort()).toEqual(["a", "b"]);
  });

  it("멱등: 정렬 결과를 다시 정렬해도 좌표 불변(핸들러의 '이미 정렬됨' 판정 근거)", () => {
    const nodes = [N("a", 300, 10), N("b", 0, 200), N("c", 90, 400)];
    const links: LayoutLink[] = [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ];
    const first = arrangeNodes(nodes, links);
    const moved = nodes.map((n) => ({ ...n, x: first[n.id].x, y: first[n.id].y }));
    const second = arrangeNodes(moved, links);
    expect(second).toEqual(first);
  });

  it("같은 열·같은 높이 카드는 세로 간격이 균일(높이가 격자 배수가 아니어도)", () => {
    // h=180 은 22 의 배수가 아니라, 예전엔 누적좌표 스냅이 위/아래로 엇갈려 간격이 198,220 처럼 달라졌다.
    const H = 180;
    // y 간격을 넉넉히(겹치지 않게) 둬 3개가 각각 다른 행(세로 스택)이 되게 한다.
    const nodes: LayoutNode[] = [
      { id: "a", x: 0, y: 0, w: 150, h: H },
      { id: "b", x: 0, y: 300, w: 150, h: H },
      { id: "c", x: 0, y: 600, w: 150, h: H },
    ];
    const pos = arrangeNodes(nodes, []);
    const gap1 = pos.b.y - pos.a.y;
    const gap2 = pos.c.y - pos.b.y;
    expect(gap1).toBe(gap2); // 같은 높이 → top-to-top 간격 동일
    for (const id of ["a", "b", "c"]) expect(pos[id].y % 22).toBe(0); // 여전히 격자 정렬
  });

  it("앵커는 선택 좌상단 근처(격자 스냅)", () => {
    const nodes = [N("a", 220, 130), N("b", 400, 300)];
    const pos = arrangeNodes(nodes, [{ from: "a", to: "b" }]);
    expect(pos.a.x).toBe(220); // 220 은 22 의 배수 → 그대로
    expect(pos.a.y).toBe(132); // min y=130 → 22 스냅 = 132
  });
});
