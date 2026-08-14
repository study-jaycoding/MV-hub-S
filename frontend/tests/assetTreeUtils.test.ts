import { describe, expect, it } from "vitest";
import {
  isAssetFolderHidden,
  orderAssetFolders,
  visibleAssetTree,
} from "../src/components/assets/treeUtils";
import type { AssetNode } from "../src/types";

function folder(name: string): AssetNode {
  return { name, path: name, type: "dir", children: [] };
}

describe("어셋 폴더 표시 순서", () => {
  it("PR을 Reference보다 먼저 표시하고 다른 폴더 순서는 유지한다", () => {
    const nodes = [folder("BG"), folder("CH"), folder("Reference"), folder("PR")];

    expect(orderAssetFolders(nodes).map((node) => node.name)).toEqual([
      "BG",
      "CH",
      "PR",
      "Reference",
    ]);
    expect(nodes.map((node) => node.name)).toEqual(["BG", "CH", "Reference", "PR"]);
  });

  it("이름 변경 전 MOSAIC도 같은 순서 규칙을 유지한다", () => {
    const nodes = [folder("BG"), folder("MOSAIC"), folder("PR")];

    expect(orderAssetFolders(nodes).map((node) => node.name)).toEqual([
      "BG",
      "PR",
      "MOSAIC",
    ]);
  });

  it("Reference가 이미 PR 뒤에 있으면 현재 순서를 그대로 유지한다", () => {
    const nodes = [folder("BG"), folder("CH"), folder("PR"), folder("Reference")];

    expect(orderAssetFolders(nodes)).toEqual(nodes);
  });

  it("둘 중 하나가 없으면 기존 순서를 유지한다", () => {
    const nodes = [folder("BG"), folder("Reference"), folder("ETC")];

    expect(orderAssetFolders(nodes)).toEqual(nodes);
  });
});

describe("뻘뻘뻘 assets 폴더 표시 규칙", () => {
  it("뻘뻘뻘에서는 Reference를 숨기고 CLIP을 맨 아래로 보낸다", () => {
    const nodes = [
      folder("BG"),
      folder("CH"),
      folder("CLIP"),
      folder("PR"),
      folder("Reference"),
    ];

    const visible = visibleAssetTree("뻘뻘뻘", nodes);
    expect(visible.map((node) => node.name)).toEqual(["BG", "CH", "CLIP", "PR"]);
    expect(orderAssetFolders(visible, "뻘뻘뻘").map((node) => node.name)).toEqual([
      "BG",
      "CH",
      "PR",
      "CLIP",
    ]);
  });

  it("뻘뻘뻘의 Reference 하위 저장 경로도 숨김 경로로 판단한다", () => {
    expect(isAssetFolderHidden("뻘뻘뻘", "assets/Reference/EP01")).toBe(true);
    expect(isAssetFolderHidden("뻘뻘뻘", "assets/CLIP/EP01")).toBe(false);
    expect(isAssetFolderHidden("다른 프로젝트", "assets/Reference/EP01")).toBe(false);
  });

  it("다른 프로젝트에서는 CLIP 맨 아래 규칙이 적용되지 않는다", () => {
    const nodes = [folder("BG"), folder("CLIP"), folder("PR")];

    expect(orderAssetFolders(nodes).map((node) => node.name)).toEqual([
      "BG",
      "CLIP",
      "PR",
    ]);
    expect(orderAssetFolders(nodes, "다른 프로젝트").map((node) => node.name)).toEqual([
      "BG",
      "CLIP",
      "PR",
    ]);
  });
});

describe("프로젝트별 에셋 폴더 표시", () => {
  it("뻘뻘뻘에서만 MOSAIC(과 Reference)·그 내용을 숨긴다", () => {
    const nodes = [
      { ...folder("MOSAIC"), children: [folder("MOSAIC/EP01")] },
      folder("Reference"),
      folder("BG"),
    ];

    expect(visibleAssetTree("뻘뻘뻘", nodes).map((node) => node.name)).toEqual(["BG"]);
    expect(visibleAssetTree("다른 프로젝트", nodes)).toBe(nodes);
    expect(nodes.map((node) => node.name)).toEqual(["MOSAIC", "Reference", "BG"]);
  });

  it("뻘뻘뻘의 MOSAIC 하위 저장 경로도 숨김 경로로 판단한다", () => {
    expect(isAssetFolderHidden("뻘뻘뻘", "MOSAIC/EP01")).toBe(true);
    expect(isAssetFolderHidden("뻘뻘뻘", "BG/EP01")).toBe(false);
    expect(isAssetFolderHidden("다른 프로젝트", "MOSAIC/EP01")).toBe(false);
  });
});
