import { describe, expect, it } from "vitest";
import {
  buildFolderCountTree,
  hasMoreThanFolderNodes,
  normalizeFolderPath,
  type FolderCountTreeNode,
} from "../src/lib/folderTreeModel";

function find(nodes: FolderCountTreeNode[], path: string): FolderCountTreeNode | undefined {
  for (const node of nodes) {
    if (node.path === path) return node;
    const nested = node.children ? find(node.children, path) : undefined;
    if (nested) return nested;
  }
  return undefined;
}

describe("프로젝트 폴더 카운트 트리", () => {
  it("레거시 경로를 정규화하고 같은 경로 개수를 합산한다", () => {
    expect(normalizeFolderPath(" /ep001//./c0010/../ ")).toBe("ep001/c0010");
    expect(normalizeFolderPath("ep001\\c0010")).toBe("ep001/c0010");

    const tree = buildFolderCountTree([], {
      "ep001/c0010": 2,
      "\\ep001\\c0010\\": 3,
    });

    expect(find(tree, "ep001/c0010")?.count).toBe(5);
  });

  it("자신과 하위 경로 개수를 부모에 한 번씩 누적한다", () => {
    const roots: FolderCountTreeNode[] = [
      {
        name: "ep001",
        path: "ep001",
        count: 99,
        children: [
          { name: "c0010", path: "ep001/c0010", count: 99, children: [] },
          { name: "c0020", path: "ep001/c0020", count: 99, children: [] },
        ],
      },
    ];

    const tree = buildFolderCountTree(
      roots,
      {
        "ep001/c0010": 2,
        "ep001/c0010/deep": 3,
        "ep001/c0020": 4,
        "ep002/new": 5,
      },
      { "ep001/c0010/deep": 2, "ep002/new": 1 },
    );

    expect(find(tree, "ep001")?.count).toBe(9);
    expect(find(tree, "ep001/c0010")?.count).toBe(5);
    expect(find(tree, "ep001/c0010")?.newCount).toBe(2);
    expect(find(tree, "ep001/c0020")?.count).toBe(4);
    expect(find(tree, "ep002")?.count).toBe(5);
    expect(find(tree, "ep002")?.virtual).toBe(true);
    expect(find(tree, "ep002/new")?.newCount).toBe(1);
    expect(roots[0].count).toBe(99); // 입력 트리는 변경하지 않는다.
  });

  it("이름 접두사가 같은 형제 경로를 서로의 하위로 세지 않는다", () => {
    const roots: FolderCountTreeNode[] = [
      { name: "shot1", path: "shot1", children: [] },
      { name: "shot10", path: "shot10", children: [] },
    ];

    const tree = buildFolderCountTree(roots, { shot1: 2, shot10: 7 });

    expect(find(tree, "shot1")?.count).toBe(2);
    expect(find(tree, "shot10")?.count).toBe(7);
  });

  it("Object 기본 속성과 같은 실제 폴더명도 정상 집계한다", () => {
    const counts = Object.fromEntries([
      ["constructor", 2],
      ["__proto__", 3],
    ]);

    const tree = buildFolderCountTree([], counts);

    expect(find(tree, "constructor")?.count).toBe(2);
    expect(find(tree, "__proto__")?.count).toBe(3);
  });

  it("조회 전에는 생성물 수를 비워 두고 파일 수만 알려준다", () => {
    // 파일 수를 생성물 수인 척 보여주면, 데이터가 도착하는 순간 숫자가 뒤집혀 보인다.
    const roots: FolderCountTreeNode[] = [{ name: "ep001", path: "ep001", count: 229, children: [] }];

    const tree = buildFolderCountTree(roots);

    expect(find(tree, "ep001")?.count).toBeNull();
    expect(find(tree, "ep001")?.fileCount).toBe(229);
  });

  it("이 워크스페이스에 생성물이 0건이어도 파일 수로 대신 채우지 않는다", () => {
    // 예전에는 counts 가 비면 디스크 파일 수를 그대로 뒀다 — 같은 자리 숫자가 '생성물 수'와
    // '파일 수' 사이를 오가 "폴더엔 224개인데 목록은 0건"으로 보였다.
    const roots: FolderCountTreeNode[] = [{ name: "e003", path: "e003", count: 229, children: [] }];

    const tree = buildFolderCountTree(roots, {});

    expect(find(tree, "e003")?.count).toBe(0);
    expect(find(tree, "e003")?.fileCount).toBe(229);
  });

  it("생성물 수로 덮어써도 디스크 파일 수는 보존한다", () => {
    const roots: FolderCountTreeNode[] = [
      {
        name: "e001", path: "e001", count: 5,
        children: [{ name: "c0010", path: "e001/c0010", count: 1, children: [] }],
      },
    ];

    const tree = buildFolderCountTree(roots, { "e001/c0010": 1 });

    expect(find(tree, "e001")?.count).toBe(1);       // 생성물(하위 누적)
    expect(find(tree, "e001")?.fileCount).toBe(5);   // 디스크 파일
    expect(find(tree, "e001/c0010")?.count).toBe(1);
    expect(find(tree, "e001/c0010")?.fileCount).toBe(1);
  });

  it("디스크에 없는 가상 폴더는 파일 수가 0이다", () => {
    const tree = buildFolderCountTree([], { "ep002/new": 5 });

    expect(find(tree, "ep002/new")?.virtual).toBe(true);
    expect(find(tree, "ep002/new")?.fileCount).toBe(0);
  });

  it("스크롤 임계값은 깊은 트리를 재귀 없이 판정한다", () => {
    let node: FolderCountTreeNode = { name: "leaf", path: "leaf", children: [] };
    for (let depth = 1_498; depth >= 0; depth -= 1) {
      node = { name: `d${depth}`, path: `d${depth}`, children: [node] };
    }

    expect(hasMoreThanFolderNodes([node], 15)).toBe(true);
    expect(hasMoreThanFolderNodes([node], 1_500)).toBe(false);
  });

  it("상태별 개수도 경로 정규화 후 부모에 한 번씩 합산한다", () => {
    const tree = buildFolderCountTree([], { "ep/shot1": 4, "ep\\shot1\\deep": 2, "ep/shot10": 2 }, undefined, {
      "ep/shot1": { final: 1, held: 1, shared: 2 },
      "ep\\shot1\\deep": { final: 0, held: 1, shared: 1 },
      "ep/shot10": { final: 0, held: 0, shared: 2 },
    });
    expect(find(tree, "ep")?.reviewCounts).toEqual({ final: 1, held: 2, shared: 5 });
    expect(find(tree, "ep/shot1")?.reviewCounts).toEqual({ final: 1, held: 2, shared: 3 });
    expect(find(tree, "ep/shot10")?.reviewCounts).toEqual({ final: 0, held: 0, shared: 2 });
    expect(find(tree, "ep")?.count).toBe(8);
  });

  it("상태 맵도 prototype 폴더명과 같은 경로의 별칭을 안전하게 누적한다", () => {
    const counts = Object.fromEntries([["__proto__/x", 2], ["/__proto__/x/", 3], ["constructor", 1]]);
    const review = Object.fromEntries([["__proto__/x", { final: 1, held: 1, shared: 0 }],
      ["/__proto__/x/", { final: 0, held: 0, shared: 3 }], ["constructor", { final: 0, held: 0, shared: 1 }]]);
    const tree = buildFolderCountTree([], counts, undefined, review);
    expect(find(tree, "__proto__")?.reviewCounts).toEqual({ final: 1, held: 1, shared: 3 });
    expect(find(tree, "constructor")?.reviewCounts).toEqual({ final: 0, held: 0, shared: 1 });
  });

  it.each([null, {}, { shot: { final: 0, held: 1, shared: 1 } },
    { shot: { final: -1, held: 1, shared: 3 } }, { shot: { final: 0, held: 1.5, shared: 1.5 } }])(
    "누락·불일치 상태 정보를 공유 건수로 추정하지 않는다 (%j)", (review) => {
      const node = buildFolderCountTree([], { shot: 3 }, undefined, review)[0];
      expect(node.count).toBe(3); expect(node.reviewCounts).toBeNull();
    },
  );

  it("기존 표시와 상세 지원 빈 결과를 구분하고 총계에 없는 상세 경로는 무시한다", () => {
    const roots = [{ path: "empty", name: "empty", count: 42 }];
    expect(buildFolderCountTree(roots, {})[0].reviewCounts).toBeUndefined();
    expect(buildFolderCountTree(roots, {}, undefined, { phantom: { final: 2, held: 0, shared: 0 } }))
      .toEqual([expect.objectContaining({ path: "empty", count: 0, reviewCounts: { final: 0, held: 0, shared: 0 } })]);
    expect(buildFolderCountTree(roots, undefined, undefined, null)[0].count).toBeNull();
  });
});
