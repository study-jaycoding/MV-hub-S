// 옛 씬의 '이 PC 안 사본' 참조를 프로젝트 폴더 원본으로 되돌리는 순수 계산(2026-09-28).
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyRelink,
  getRefServerStatusVersion,
  markRefsLocal,
  refServerStatus,
  relinkKey,
  relinkSceneAssetRefs,
  sceneAssetGroups,
  sceneAssetTokens,
  sceneRefWorkspaceId,
  subscribeRefServerStatus,
} from "../src/lib/sceneAssetRelink";
import { saveScenes, type Scene } from "../src/lib/scenes";

const locate = vi.fn();
vi.mock("../src/api", () => ({
  api: {
    locateAssets: (tokens: string[], ws?: string, scanId?: string, fingerprints?: unknown) =>
      locate(tokens, ws, scanId, fingerprints),
  },
}));

const scene = (
  refs: { file_path: string; thumb?: string | null; content_sha?: string; bytes?: number }[],
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
      { workspaceId: "ws-1", tokens: ["asset:P|a.png"], fingerprints: {} },
      { workspaceId: "ws-2", tokens: ["asset:P|b.png"], fingerprints: {} },
      { workspaceId: "", tokens: ["asset:P|c.png"], fingerprints: {} },
    ]);
  });

  it("참조가 든 지문을 함께 싣되, 한 토큰의 참조가 모두 같은 지문일 때만 싣는다(2026-09-29, Codex)", () => {
    const fp = { content_sha: "a".repeat(64), bytes: 10 };
    const scenes = [
      scene([
        { file_path: "asset:imports|same.png", ...fp },
        { file_path: "asset:imports|mixed.png", ...fp },
        { file_path: "asset:imports|differs.png", ...fp },
        { file_path: "asset:imports|none.png" },
      ]),
      scene([
        { file_path: "asset:imports|same.png", ...fp },
        { file_path: "asset:imports|mixed.png" }, // 지문 없는 옛 참조가 같은 토큰을 쓴다
        { file_path: "asset:imports|differs.png", content_sha: "b".repeat(64), bytes: 10 },
      ]),
    ];
    const [group] = sceneAssetGroups(scenes);
    expect(group.tokens).toEqual([
      "asset:imports|same.png",
      "asset:imports|mixed.png",
      "asset:imports|differs.png",
      "asset:imports|none.png",
    ]);
    expect(group.fingerprints).toEqual({ "asset:imports|same.png": { sha256: "a".repeat(64), bytes: 10 } });
  });

  it("씬 파일로 받은 공간 힌트로도 묶는다 — 탭에 고른 공간이 있으면 그것이 앞선다(2026-09-29)", () => {
    const hinted = { ...scene([{ file_path: "asset:P|a.png" }]), refWorkspaceHint: { id: "ws-h", name: "힌트" } };
    const both = {
      ...scene([{ file_path: "asset:P|b.png" }], { id: "ws-tab", name: "탭" }),
      refWorkspaceHint: { id: "ws-h", name: "힌트" },
    };
    expect(sceneRefWorkspaceId(hinted)).toBe("ws-h");
    expect(sceneRefWorkspaceId(both)).toBe("ws-tab");
    expect(sceneAssetGroups([hinted, both])).toEqual([
      { workspaceId: "ws-h", tokens: ["asset:P|a.png"], fingerprints: {} },
      { workspaceId: "ws-tab", tokens: ["asset:P|b.png"], fingerprints: {} },
    ]);
    // 답도 같은 열쇠로 받는다 — 물을 때와 반영할 때의 공간이 어긋나지 않게
    const found = new Map([[relinkKey("ws-h", "asset:P|a.png"), { project: "Q", path: "CH/a.png" }]]);
    expect(applyRelink([hinted], found).scenes[0].cards[0].refs![0].file_path).toBe("asset:Q|CH/a.png");
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

  it("참조가 든 지문과 다른 답은 적용하지 않는다 — 같은 토큰의 다른 그림·지문 없는 경로 답(2026-09-29, Codex)", () => {
    const mine = "a".repeat(64);
    const scenes = [
      scene([
        { file_path: "asset:imports|x.png", content_sha: mine, bytes: 10 }, // 이 그림의 지문
        { file_path: "asset:imports|x.png" }, // 같은 토큰, 지문 없는 옛 참조
      ]),
    ];
    const answer = (hit: { sha256?: string; bytes?: number }) =>
      applyRelink(scenes, new Map([[relinkKey("", "asset:imports|x.png"), { project: "P", path: "CH/x.png", ...hit }]]))
        .scenes[0].cards[0].refs!.map((ref) => ref.file_path);

    // 같은 지문의 답 — 둘 다 잇는다
    expect(answer({ sha256: mine, bytes: 10 })).toEqual(["asset:P|CH/x.png", "asset:P|CH/x.png"]);
    // 다른 그림의 답 — 지문을 가진 참조는 그대로
    expect(answer({ sha256: "b".repeat(64), bytes: 10 })).toEqual(["asset:imports|x.png", "asset:P|CH/x.png"]);
    // 지문 없이 경로로 찾은 답 — 지문을 가진 참조는 그대로(내용으로만 잇는다)
    expect(answer({})).toEqual(["asset:imports|x.png", "asset:P|CH/x.png"]);
    // 지문은 같은데 크기가 다르면 — 그대로
    expect(answer({ sha256: mine, bytes: 11 })).toEqual(["asset:imports|x.png", "asset:P|CH/x.png"]);
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

  it("참조가 든 지문을 그 배치의 토큰만큼 함께 보낸다(2026-09-29)", async () => {
    const fp = { content_sha: "c".repeat(64), bytes: 7 };
    saveScenes(null, [
      scene([{ file_path: "asset:imports|with.png", ...fp }, { file_path: "asset:imports|without.png" }]),
    ]);
    locate.mockResolvedValue({ fixed: [], unresolved: [], missing: [], local: [] });

    await relinkSceneAssetRefs();

    expect(locate.mock.calls[0][0]).toEqual(["asset:imports|with.png", "asset:imports|without.png"]);
    expect(locate.mock.calls[0][3]).toEqual({ "asset:imports|with.png": { sha256: "c".repeat(64), bytes: 7 } });
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

describe("서버에 없는 참조 기억하기(2026-09-29)", () => {
  beforeEach(() => {
    localStorage.clear();
    locate.mockReset();
  });

  it("서버 답의 missing·local 을 그 공간의 참조에만 기억하고, 바뀌면 한 번 알린다", async () => {
    saveScenes(null, [
      scene(
        [
          { file_path: "asset:Q|gone.png" },
          { file_path: "asset:imports|mine.png" },
          { file_path: "asset:P|ok.png" },
        ],
        { id: "ws-s", name: "가" },
      ),
    ]);
    locate.mockResolvedValue({
      fixed: [],
      unresolved: ["asset:Q|gone.png", "asset:imports|mine.png", "asset:P|ok.png"],
      missing: ["asset:Q|gone.png"],
      local: ["asset:imports|mine.png"],
    });
    const heard = vi.fn();
    const off = subscribeRefServerStatus(heard);
    const before = getRefServerStatusVersion();

    await relinkSceneAssetRefs();
    off();

    expect(refServerStatus("ws-s", "asset:Q|gone.png")).toBe("missing");
    expect(refServerStatus("ws-s", "asset:imports|mine.png")).toBe("local");
    expect(refServerStatus("ws-s", "asset:P|ok.png")).toBeUndefined(); // 열리는 것은 표시 없음
    expect(refServerStatus("", "asset:Q|gone.png")).toBeUndefined(); // 다른 공간의 씬에는 번지지 않는다
    expect(getRefServerStatusVersion()).toBe(before + 1);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("다음에 물었을 때 답에서 빠지면(고쳐졌거나 이제 열림) 표시를 지운다", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      saveScenes(null, [scene([{ file_path: "asset:Q|later.png" }])]);
      locate.mockResolvedValue({
        fixed: [],
        unresolved: ["asset:Q|later.png"],
        missing: ["asset:Q|later.png"],
        local: [],
      });
      await relinkSceneAssetRefs();
      expect(refServerStatus("", "asset:Q|later.png")).toBe("missing");

      vi.setSystemTime(Date.now() + 3 * 60_000); // 2분이 지나면 같은 참조를 다시 묻는다
      locate.mockResolvedValue({ fixed: [], unresolved: ["asset:Q|later.png"], missing: [], local: [] });
      await relinkSceneAssetRefs();
      expect(locate).toHaveBeenCalledTimes(2);
      expect(refServerStatus("", "asset:Q|later.png")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("방금 이 PC 에 넣은 참조(2026-09-29 옛 방식)", () => {
  beforeEach(() => {
    localStorage.clear();
    locate.mockReset();
  });

  it("서버 답 전에 먼저 '이 PC에만'으로 보이고, 서버에 같은 내용이 있다는 답이 오면 표시가 지워진다", async () => {
    const heard = vi.fn();
    const off = subscribeRefServerStatus(heard);
    markRefsLocal("ws-m", ["asset:imports|dropped.png"]);
    off();
    expect(refServerStatus("ws-m", "asset:imports|dropped.png")).toBe("local");
    expect(heard).toHaveBeenCalledTimes(1);

    saveScenes(null, [scene([{ file_path: "asset:imports|dropped.png" }], { id: "ws-m", name: "가" })]);
    locate.mockResolvedValue({
      fixed: [{ token: "asset:imports|dropped.png", project: "P", path: "BG/d.png" }],
      unresolved: [],
      missing: [],
      local: [],
    });
    await relinkSceneAssetRefs();
    expect(refServerStatus("ws-m", "asset:imports|dropped.png")).toBeUndefined();
  });

  it("같은 파일을 2분 안에 다시 끌어다 놓아도 다시 물어 원본으로 잇는다(Codex)", async () => {
    const token = "asset:imports|again.png";
    locate.mockResolvedValue({
      fixed: [{ token, project: "P", path: "BG/again.png" }],
      unresolved: [],
      missing: [],
      local: [],
    });
    saveScenes(null, [scene([{ file_path: token }], { id: "ws-a", name: "가" })]);
    markRefsLocal("ws-a", [token]);
    expect(await relinkSceneAssetRefs()).toBe(1);

    // 곧바로 같은 파일을 다시 끌어다 놓음 — 같은 이 PC 사본 토큰이 다시 생긴다
    saveScenes(null, [scene([{ file_path: token }], { id: "ws-a", name: "가" })]);
    markRefsLocal("ws-a", [token]);
    expect(await relinkSceneAssetRefs()).toBe(1);
    expect(locate).toHaveBeenCalledTimes(2);
  });

  it("도는 중에 또 불리면 끝난 뒤 한 번 더 돈다 — 마지막 바퀴 뒤에 들어온 참조도 놓치지 않는다(Codex)", async () => {
    const tokens = Array.from({ length: 8 }, (_, i) => `asset:Q|drop${i}.png`);
    let shown = 1;
    saveScenes(null, [scene([{ file_path: tokens[0] }])]);
    locate.mockImplementation(async () => {
      await Promise.resolve(); // 실제 요청처럼 한 박자 뒤에 답한다 — 그 사이 '도는 중' 표시가 잡혀 있다
      // 물을 때마다 새 참조가 하나씩 생기고(끌어다 놓기) 그때마다 다시 부른다 — 도는 중이라 합쳐진다
      if (shown < tokens.length) {
        shown += 1;
        saveScenes(null, [scene(tokens.slice(0, shown).map((file_path) => ({ file_path })))]);
        void relinkSceneAssetRefs();
      }
      return { fixed: [], unresolved: [], missing: [], local: [] };
    });

    await relinkSceneAssetRefs();

    const asked = new Set(locate.mock.calls.flatMap((call) => call[0] as string[]));
    expect(tokens.filter((token) => !asked.has(token))).toEqual([]); // 한 번에 다섯 바퀴를 넘어도 끝까지 물었다
  });
});
