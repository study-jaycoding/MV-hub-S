// 옛 씬의 '이 PC 안 사본' 참조를 프로젝트 폴더 원본으로 되돌리는 순수 계산(2026-09-28).
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyRelink,
  relinkKey,
  relinkSceneAssetRefs,
  sceneAssetGroups,
  sceneAssetTokens,
} from "../src/lib/sceneAssetRelink";
import { saveScenes, type Scene } from "../src/lib/scenes";

const locate = vi.fn();
vi.mock("../src/api", () => ({
  api: {
    locateAssets: (tokens: string[], ws?: string, scanId?: string) => locate(tokens, ws, scanId),
  },
}));

const scene = (
  refs: { file_path: string; thumb?: string | null }[],
  workspace?: { id: string; name: string | null },
): Scene =>
  ({
    id: "s1",
    name: "씬",
    workspace,
    cards: [
      { id: "c1", kind: "reference", x: 0, y: 0, refs: refs.map((r) => ({ type: "image", ...r })) },
      { id: "c2", kind: "generation", x: 0, y: 0, genId: "g1" },
    ],
    edges: [],
  }) as unknown as Scene;

describe("물어볼 참조 모으기", () => {
  it("에셋 참조를 모두 고른다 — 어느 것이 안 열리는지는 폴더를 보는 서버만 안다", () => {
    const scenes = [
      scene([
        { file_path: "asset:imports|a.png" },
        { file_path: "asset:captures|b.png" },
        { file_path: "asset:imp/cap|imports/c.png" },
        // 프로젝트 이름이 붙어도 그 프로젝트를 못 보면 빈칸이다 — 이것도 물어봐야 한다
        { file_path: "asset:뻘뻘뻘_RnD|CH/바바라/d.png" },
        { file_path: "https://cdn.example/e.png" }, // 원격 URL — 에셋이 아니다
        { file_path: "asset:깨진것" }, // 구분자(|)가 없다 — 물어볼 수 없다
      ]),
    ];
    expect(sceneAssetTokens(scenes)).toEqual([
      "asset:imports|a.png",
      "asset:captures|b.png",
      "asset:imp/cap|imports/c.png",
      "asset:뻘뻘뻘_RnD|CH/바바라/d.png",
    ]);
  });

  it("캔버스 탭의 공간별로 묶는다 — 서버가 그 공간의 프로젝트 폴더부터 찾게", () => {
    const a = scene([{ file_path: "asset:P|a.png" }], { id: "ws-1", name: "가" });
    const b = scene([{ file_path: "asset:P|b.png" }], { id: "ws-2", name: "나" });
    const none = scene([{ file_path: "asset:P|c.png" }]); // 공간 지정 없음
    expect(sceneAssetGroups([a, b, none])).toEqual([
      { workspaceId: "ws-1", tokens: ["asset:P|a.png"] },
      { workspaceId: "ws-2", tokens: ["asset:P|b.png"] },
      { workspaceId: "", tokens: ["asset:P|c.png"] },
    ]);
  });

  it("같은 토큰이 여러 카드에 있어도 한 번만 묻는다", () => {
    const scenes = [scene([{ file_path: "asset:imports|a.png" }]), scene([{ file_path: "asset:imports|a.png" }])];
    expect(sceneAssetTokens(scenes)).toEqual(["asset:imports|a.png"]);
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
      // 공간이 없는 씬 — 열쇠의 공간 몫은 빈 문자열
      [relinkKey("", "asset:imports|a.png"), { project: "뻘뻘뻘", path: "BG/갯벌/a.png", sha256: "abc", bytes: 12 }],
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

  it("같은 옛 참조라도 **각 씬은 자기 공간의 답만** 받는다", () => {
    // 두 캔버스가 같은 옛 참조를 쓰지만 공간이 다르다 — 각 공간에서 다른 파일로 찾혔다.
    // 참조만 열쇠로 쓰면 나중 공간의 답이 다른 공간 씬까지 덮는다(Codex 2026-09-28).
    const a = { ...scene([{ file_path: "asset:old|hero.png" }], { id: "ws-A", name: "가" }), id: "a" };
    const b2 = { ...scene([{ file_path: "asset:old|hero.png" }], { id: "ws-B", name: "나" }), id: "b" };
    const found = new Map([
      [relinkKey("ws-A", "asset:old|hero.png"), { project: "A", path: "CH/hero.png" }],
      [relinkKey("ws-B", "asset:old|hero.png"), { project: "B", path: "CH/hero.png" }],
    ]);

    const { scenes: next, changed } = applyRelink([a, b2], found);

    expect(changed).toBe(2);
    expect(next[0].cards[0].refs![0].file_path).toBe("asset:A|CH/hero.png");
    expect(next[1].cards[0].refs![0].file_path).toBe("asset:B|CH/hero.png");
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

    await relinkSceneAssetRefs();

    // 250개 = 200 + 50 두 번. 한 번만 보내면 뒤 50개가 조용히 잘린다.
    expect(locate).toHaveBeenCalledTimes(2);
    expect(locate.mock.calls[0][0]).toHaveLength(200);
    expect(locate.mock.calls[1][0]).toHaveLength(50);
    // 한 번의 복구는 같은 작업 id 를 싣는다 — 서버가 두 번째 배치에서 NAS 를 다시 훑지 않게
    expect(locate.mock.calls[0][2]).toBeTruthy();
    expect(locate.mock.calls[1][2]).toBe(locate.mock.calls[0][2]);
  });

  it("찾은 것을 씬에 저장하고, 곧바로 다시 부르면 같은 것을 또 묻지 않는다", async () => {
    saveScenes(null, [scene([{ file_path: "asset:imports|found.png" }], { id: "ws-9", name: "가" })]);
    locate.mockResolvedValue({
      fixed: [{ token: "asset:imports|found.png", project: "P", path: "BG/a.png", sha256: "s", bytes: 3 }],
      unresolved: [],
    });

    expect(await relinkSceneAssetRefs()).toBe(1);
    expect(locate).toHaveBeenCalledTimes(1);
    expect(locate.mock.calls[0][1]).toBe("ws-9"); // 그 캔버스의 공간이 함께 간다

    // 저장된 씬은 이미 프로젝트 주소라 다시 물을 토큰이 없다
    expect(await relinkSceneAssetRefs()).toBe(0);
    expect(locate).toHaveBeenCalledTimes(1);
  });

  it("서버가 실패하면 삼키고, 다음 기회에 다시 묻는다", async () => {
    saveScenes(null, [scene([{ file_path: "asset:imports|retry.png" }])]);
    locate.mockRejectedValueOnce(new Error("서버 없음"));

    expect(await relinkSceneAssetRefs()).toBe(0); // 화면은 지금까지처럼 동작

    locate.mockResolvedValue({
      fixed: [{ token: "asset:imports|retry.png", project: "P", path: "BG/a.png" }],
      unresolved: [],
    });
    expect(await relinkSceneAssetRefs()).toBe(1); // 실패는 '물어봤다'로 치지 않는다
  });
});
