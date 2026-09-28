// 옛 씬의 '이 PC 안 사본' 참조를 프로젝트 폴더 원본으로 되돌리는 순수 계산(2026-09-28).
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyRelink, legacyAssetTokens, relinkLegacyAssetRefs } from "../src/lib/sceneAssetRelink";
import { saveScenes, type Scene } from "../src/lib/scenes";

const locate = vi.fn();
vi.mock("../src/api", () => ({ api: { locateAssets: (tokens: string[]) => locate(tokens) } }));

const scene = (refs: { file_path: string; thumb?: string | null }[]): Scene =>
  ({
    id: "s1",
    name: "씬",
    cards: [
      { id: "c1", kind: "reference", x: 0, y: 0, refs: refs.map((r) => ({ type: "image", ...r })) },
      { id: "c2", kind: "generation", x: 0, y: 0, genId: "g1" },
    ],
    edges: [],
  }) as unknown as Scene;

describe("옛 참조 찾기", () => {
  it("이 PC 안 사본(imports·captures·합본)만 고른다", () => {
    const scenes = [
      scene([
        { file_path: "asset:imports|a.png" },
        { file_path: "asset:captures|b.png" },
        { file_path: "asset:imp/cap|imports/c.png" },
        { file_path: "asset:뻘뻘뻘|BG/d.png" }, // 이미 프로젝트 기준 — 대상 아님
        { file_path: "https://cdn.example/e.png" }, // 원격 URL — 대상 아님
      ]),
    ];
    expect(legacyAssetTokens(scenes)).toEqual([
      "asset:imports|a.png",
      "asset:captures|b.png",
      "asset:imp/cap|imports/c.png",
    ]);
  });

  it("같은 토큰이 여러 카드에 있어도 한 번만 묻는다", () => {
    const scenes = [scene([{ file_path: "asset:imports|a.png" }]), scene([{ file_path: "asset:imports|a.png" }])];
    expect(legacyAssetTokens(scenes)).toEqual(["asset:imports|a.png"]);
  });
});

describe("찾은 것 갈아끼우기", () => {
  it("찾은 참조만 프로젝트 주소로 바꾸고 옛 썸네일은 버린다", () => {
    const scenes = [
      scene([
        { file_path: "asset:imports|a.png", thumb: "/api/assets/thumb?project=imports&path=a.png" },
        { file_path: "asset:imports|없는것.png", thumb: "keep" },
      ]),
    ];
    const found = new Map([
      ["asset:imports|a.png", { project: "뻘뻘뻘", path: "BG/갯벌/a.png", sha256: "abc", bytes: 12 }],
    ]);

    const { scenes: next, changed } = applyRelink(scenes, found);

    expect(changed).toBe(1);
    const refs = next[0].cards[0].refs!;
    expect(refs[0].file_path).toBe("asset:뻘뻘뻘|BG/갯벌/a.png");
    expect(refs[0].thumb).toBeNull();
    expect(refs[0].content_sha).toBe("abc"); // 다음에 또 옮겨져도 내용으로 찾게 표식을 남긴다
    expect(refs[0].bytes).toBe(12);
    expect(refs[1]).toEqual(scenes[0].cards[0].refs![1]); // 못 찾은 것은 그대로
  });

  it("찾은 게 없으면 씬 객체를 그대로 돌려준다(저장도 일어나지 않게)", () => {
    const scenes = [scene([{ file_path: "asset:imports|a.png" }])];
    const { scenes: next, changed } = applyRelink(scenes, new Map());
    expect(changed).toBe(0);
    expect(next).toBe(scenes);
  });
});

describe("서버에 묻고 갈아끼우기", () => {
  beforeEach(() => {
    localStorage.clear();
    locate.mockReset();
  });

  it("서버 상한(200개)을 넘으면 나눠 보내고, 보낸 것만 '물어봤다'로 친다", async () => {
    const refs = Array.from({ length: 250 }, (_, i) => ({ file_path: `asset:imports|f${i}.png` }));
    saveScenes(null, [scene(refs)]);
    locate.mockResolvedValue({ fixed: [], unresolved: [] });

    await relinkLegacyAssetRefs();

    // 250개 = 200 + 50 두 번. 한 번만 보내면 뒤 50개가 조용히 잘린다.
    expect(locate).toHaveBeenCalledTimes(2);
    expect(locate.mock.calls[0][0]).toHaveLength(200);
    expect(locate.mock.calls[1][0]).toHaveLength(50);
  });

  it("찾은 것을 씬에 저장하고, 곧바로 다시 부르면 같은 것을 또 묻지 않는다", async () => {
    saveScenes(null, [scene([{ file_path: "asset:imports|found.png" }])]);
    locate.mockResolvedValue({
      fixed: [{ token: "asset:imports|found.png", project: "P", path: "BG/a.png", sha256: "s", bytes: 3 }],
      unresolved: [],
    });

    expect(await relinkLegacyAssetRefs()).toBe(1);
    expect(locate).toHaveBeenCalledTimes(1);

    // 저장된 씬은 이미 프로젝트 주소라 다시 물을 토큰이 없다
    expect(await relinkLegacyAssetRefs()).toBe(0);
    expect(locate).toHaveBeenCalledTimes(1);
  });

  it("서버가 실패하면 삼키고, 다음 기회에 다시 묻는다", async () => {
    saveScenes(null, [scene([{ file_path: "asset:imports|retry.png" }])]);
    locate.mockRejectedValueOnce(new Error("서버 없음"));

    expect(await relinkLegacyAssetRefs()).toBe(0); // 화면은 지금까지처럼 동작

    locate.mockResolvedValue({
      fixed: [{ token: "asset:imports|retry.png", project: "P", path: "BG/a.png" }],
      unresolved: [],
    });
    expect(await relinkLegacyAssetRefs()).toBe(1); // 실패는 '물어봤다'로 치지 않는다
  });
});
