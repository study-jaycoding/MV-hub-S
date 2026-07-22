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

  it("연결 없는 노드들은 한 열에 세로로 정돈(x 동일)", () => {
    const nodes = [N("a", 10, 0), N("b", 500, 30), N("c", 900, 80)];
    const pos = arrangeNodes(nodes, []);
    expect(pos.a.x).toBe(pos.b.x);
    expect(pos.b.x).toBe(pos.c.x);
    expect(pos.a.y).toBeLessThan(pos.b.y);
    expect(pos.b.y).toBeLessThan(pos.c.y);
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

  it("앵커는 선택 좌상단 근처(격자 스냅)", () => {
    const nodes = [N("a", 220, 130), N("b", 400, 300)];
    const pos = arrangeNodes(nodes, [{ from: "a", to: "b" }]);
    expect(pos.a.x).toBe(220); // 220 은 22 의 배수 → 그대로
    expect(pos.a.y).toBe(132); // min y=130 → 22 스냅 = 132
  });
});
