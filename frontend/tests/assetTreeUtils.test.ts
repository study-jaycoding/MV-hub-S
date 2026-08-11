import { describe, expect, it } from "vitest";
import { orderAssetFolders } from "../src/components/assets/treeUtils";
import type { AssetNode } from "../src/types";

function folder(name: string): AssetNode {
  return { name, path: name, type: "dir", children: [] };
}

describe("어셋 폴더 표시 순서", () => {
  it("PR을 MOSAIC보다 먼저 표시하고 다른 폴더 순서는 유지한다", () => {
    const nodes = [folder("BG"), folder("CH"), folder("MOSAIC"), folder("PR")];

    expect(orderAssetFolders(nodes).map((node) => node.name)).toEqual([
      "BG",
      "CH",
      "PR",
      "MOSAIC",
    ]);
    expect(nodes.map((node) => node.name)).toEqual(["BG", "CH", "MOSAIC", "PR"]);
  });

  it("둘 중 하나가 없으면 기존 순서를 유지한다", () => {
    const nodes = [folder("BG"), folder("MOSAIC"), folder("ETC")];

    expect(orderAssetFolders(nodes)).toEqual(nodes);
  });
});
