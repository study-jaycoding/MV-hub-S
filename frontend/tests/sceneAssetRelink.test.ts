// 옛 씬의 '이 PC 안 사본' 참조를 프로젝트 폴더 원본으로 되돌리는 순수 계산(2026-09-28).
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setAccountScope } from "../src/lib/accountScope";
import {
  applyRelink,
  findSceneAssetRefs,
  findSummaryText,
  forceRefsAsk,
  forceSceneRefsAsk,
  heldText,
  getRefServerStatusVersion,
  recheckBrokenRef,
  refHeldInfo,
  refJudged,
  refServerStatus,
  relinkCards,
  relinkKey,
  relinkSceneAssetRefs,
  resetRelinkSessionForTest,
  sceneAssetGroups,
  sceneAssetTokens,
  sceneRefWorkspaceId,
  subscribeRefServerStatus,
} from "../src/lib/sceneAssetRelink";
import { listScenes, saveScenes, type Scene } from "../src/lib/scenes";
import { loadSceneHistory, sameSnap, saveSceneHistory } from "../src/lib/sceneUndoStore";
import { failSceneStoreWritesForTest } from "../src/lib/sceneStore";
import { STORAGE_KEYS } from "../src/lib/storageKeys";

const locate = vi.fn();
vi.mock("../src/api", () => ({
  api: {
    locateAssets: (
      tokens: string[],
      ws?: string,
      scanId?: string,
      fingerprints?: unknown,
      signal?: unknown,
      includeRender?: boolean,
      registryIds?: unknown,
    ) => locate(tokens, ws, scanId, fingerprints, signal, includeRender, registryIds),
  },
}));

const scene = (
  refs: { file_path: string; thumb?: string | null; content_sha?: string; bytes?: number; registry_asset_id?: string }[],
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

// 참조 하나의 표시 판정(서버에 없음·이 PC 에만) — 표시는 참조의 지문까지 본다.
const status = (ws: string, file_path: string, fp: { content_sha?: string; bytes?: number } = {}) =>
  refServerStatus(ws, { file_path, ...fp });
// 서버 답 — 빈 목록 기본값
const answer = (reply: Record<string, unknown>) => ({ fixed: [], unresolved: [], missing: [], local: [], ...reply });
// 이 계정(로그인 없음 = local) 칸에 저장된 판정 열쇠
const storedKeys = (ns = "local") =>
  Object.keys((JSON.parse(localStorage.getItem(STORAGE_KEYS.sceneRefVerdicts) || "{}") as Record<string, object>)[ns] || {});

describe("물어볼 참조 모으기", () => {
  it("에셋 참조를 모두 고른다 — 어느 것이 안 열리는지는 폴더를 보는 서버만 안다", async () => {
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

  it("캔버스 탭의 공간별로 묶는다 — 서버가 그 공간의 프로젝트 폴더부터 찾게", async () => {
    const a = scene([{ file_path: "asset:P|a.png" }], { id: "ws-1", name: "가" });
    const b = scene([{ file_path: "asset:P|b.png" }], { id: "ws-2", name: "나" });
    const none = scene([{ file_path: "asset:P|c.png" }]); // 공간 지정 없음
    expect(sceneAssetGroups([a, b, none])).toEqual([
      { workspaceId: "ws-1", tokens: ["asset:P|a.png"], fingerprints: {}, registryIds: {} },
      { workspaceId: "ws-2", tokens: ["asset:P|b.png"], fingerprints: {}, registryIds: {} },
      { workspaceId: "", tokens: ["asset:P|c.png"], fingerprints: {}, registryIds: {} },
    ]);
  });

  it("참조가 든 지문을 함께 싣되, 한 토큰의 참조가 모두 같은 지문일 때만 싣는다(2026-09-29, Codex)", async () => {
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

  it("씬 파일로 받은 공간 힌트로도 묶는다 — 탭에 고른 공간이 있으면 그것이 앞선다(2026-09-29)", async () => {
    const hinted = { ...scene([{ file_path: "asset:P|a.png" }]), refWorkspaceHint: { id: "ws-h", name: "힌트" } };
    const both = {
      ...scene([{ file_path: "asset:P|b.png" }], { id: "ws-tab", name: "탭" }),
      refWorkspaceHint: { id: "ws-h", name: "힌트" },
    };
    expect(sceneRefWorkspaceId(hinted)).toBe("ws-h");
    expect(sceneRefWorkspaceId(both)).toBe("ws-tab");
    expect(sceneAssetGroups([hinted, both])).toEqual([
      { workspaceId: "ws-h", tokens: ["asset:P|a.png"], fingerprints: {}, registryIds: {} },
      { workspaceId: "ws-tab", tokens: ["asset:P|b.png"], fingerprints: {}, registryIds: {} },
    ]);
    // 답도 같은 열쇠로 받는다 — 물을 때와 반영할 때의 공간이 어긋나지 않게
    const found = new Map([[relinkKey("ws-h", "asset:P|a.png"), { project: "Q", path: "CH/a.png" }]]);
    expect(applyRelink([hinted], found).scenes[0].cards[0].refs![0].file_path).toBe("asset:Q|CH/a.png");
  });

  it("같은 토큰이 여러 카드에 있어도 한 번만 묻는다", async () => {
    const scenes = [scene([{ file_path: "asset:imports|a.png" }]), scene([{ file_path: "asset:imports|a.png" }])];
    expect(sceneAssetTokens(scenes)).toEqual(["asset:imports|a.png"]);
  });
});

describe("찾은 것 갈아끼우기", () => {
  it("찾은 참조만 프로젝트 주소로 바꾸고 옛 썸네일은 버린다", async () => {
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

  it("같은 옛 참조라도 **각 씬은 자기 공간의 답만** 받는다", async () => {
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

  it("참조가 든 지문과 다른 답은 적용하지 않는다 — 같은 토큰의 다른 그림·지문 없는 경로 답(2026-09-29, Codex)", async () => {
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

  it("찾은 게 없으면 씬 객체를 그대로 돌려준다(저장도 일어나지 않게)", async () => {
    const scenes = [scene([{ file_path: "asset:imports|a.png" }])];
    const { scenes: next, changed } = applyRelink(scenes, new Map());
    expect(changed).toBe(0);
    expect(next).toBe(scenes);
  });

  it("바뀐 카드·씬만 새 객체다 — 안 바뀐 것은 같은 객체라 화면이 다시 그리지 않는다(2026-09-29)", async () => {
    const touched = { ...scene([{ file_path: "asset:imports|a.png" }]), id: "t" };
    const untouched = { ...scene([{ file_path: "asset:P|CH/b.png" }]), id: "u" };
    const found = new Map([[relinkKey("", "asset:imports|a.png"), { project: "P", path: "CH/a.png" }]]);

    const { scenes: next } = applyRelink([touched, untouched], found);
    expect(next[0]).not.toBe(touched);
    expect(next[0].cards[1]).toBe(touched.cards[1]); // 같은 씬의 안 바뀐 카드(생성 카드)
    expect(next[1]).toBe(untouched);

    const cards = relinkCards(untouched.cards, "", found);
    expect(cards).toEqual({ cards: untouched.cards, changed: 0 });
    expect(cards.cards).toBe(untouched.cards);
  });
});

describe("서버에 묻고 갈아끼우기", () => {
  beforeEach(async () => {
    localStorage.clear();
    resetRelinkSessionForTest();
    locate.mockReset();
  });

  it("서버 상한(200개)을 넘으면 나눠 보내고, 보낸 것만 '물어봤다'로 친다", async () => {
    const refs = Array.from({ length: 250 }, (_, i) => ({ file_path: `asset:imports|f${i}.png` }));
    await saveScenes(null, [scene(refs)]);
    locate.mockResolvedValue({ fixed: [], unresolved: [] });

    await relinkSceneAssetRefs();

    // 250개 = 200 + 50 두 번. 한 번만 보내면 뒤 50개가 조용히 잘린다.
    expect(locate).toHaveBeenCalledTimes(2);
    expect(locate.mock.calls[0][0]).toHaveLength(200);
    expect(locate.mock.calls[1][0]).toHaveLength(50);
    // 한 번의 복구는 같은 작업 id 를 싣는다 — 서버가 두 번째 배치에서 NAS 를 다시 훑지 않게
    expect(locate.mock.calls[0][2]).toBeTruthy();
    expect(locate.mock.calls[1][2]).toBe(locate.mock.calls[0][2]);
    // 자동 복구는 render 폴더를 훑지 않는다(단추만)
    expect(locate.mock.calls[0][5]).toBeFalsy();
  });

  it("찾은 것을 씬에 저장하고, 곧바로 다시 부르면 같은 것을 또 묻지 않는다", async () => {
    await saveScenes(null, [scene([{ file_path: "asset:imports|found.png" }], { id: "ws-9", name: "가" })]);
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
    await saveScenes(null, [
      scene([{ file_path: "asset:imports|with.png", ...fp }, { file_path: "asset:imports|without.png" }]),
    ]);
    locate.mockResolvedValue({ fixed: [], unresolved: [], missing: [], local: [] });

    await relinkSceneAssetRefs();

    expect(locate.mock.calls[0][0]).toEqual(["asset:imports|with.png", "asset:imports|without.png"]);
    expect(locate.mock.calls[0][3]).toEqual({ "asset:imports|with.png": { sha256: "c".repeat(64), bytes: 7 } });
  });

  it("답을 받은 그 자리에서 열린 캔버스에 먼저 입히고, 나머지 씬은 저장 직후 화면에 맞춘다(2026-09-29)", async () => {
    const active = { ...scene([{ file_path: "asset:imports|a.png" }]), id: "active" };
    const other = { ...scene([{ file_path: "asset:imports|a.png" }]), id: "other" };
    await saveScenes(null, [active, other]);
    locate.mockResolvedValue({
      fixed: [{ token: "asset:imports|a.png", project: "P", path: "CH/a.png" }],
      unresolved: [],
      missing: [],
      local: [],
    });
    const order: string[] = [];
    const applyToBoard = vi.fn(async (found: Map<string, unknown>) => {
      order.push("board");
      expect(found.has(relinkKey("", "asset:imports|a.png"))).toBe(true);
      // 캔버스는 자기 메모리의 활성 씬을 고쳐 저장한다(여기서는 그것을 흉내 낸다)
      const saved = listScenes(null).map((s) => (s.id === "active" ? applyRelink([s], found as never).scenes[0] : s));
      await saveScenes(null, saved);
      return 1;
    });
    const onSaved = vi.fn((next: Scene[], boardApplied: boolean) => {
      order.push("saved");
      // 저장된 값 그대로 — 끝난 뒤 목록을 다시 읽지 않아도 화면이 맞다
      expect(next).toEqual(listScenes(null));
      expect(boardApplied).toBe(true);
    });

    expect(await relinkSceneAssetRefs({ applyToBoard, onSaved })).toBe(2);
    expect(order).toEqual(["board", "saved"]);
    expect(listScenes(null).map((s) => s.cards[0].refs![0].file_path)).toEqual([
      "asset:P|CH/a.png",
      "asset:P|CH/a.png",
    ]);
  });

  it("비활성 씬의 실행 취소 기록에도 입힌다 — 돌아가도 Ctrl+Z 가 남고 전이 메타도 그대로(2026-10-03 점검 CXF-5)", async () => {
    const snap = (s: Scene) => ({ cards: s.cards, edges: s.edges, groups: s.groups || [] });
    const b = { ...scene([{ file_path: "asset:imports|a.png" }]), id: "cxf5-b" };
    const c = { ...scene([{ file_path: "asset:imports|a.png" }]), id: "cxf5-c" };
    await saveScenes(null, [b, c]);
    const removed = [{ cardId: "c2", genIds: ["g1"] }];
    saveSceneHistory(b.id, { undo: [{ ...snap(b), cards: b.cards.slice(0, 1), removedForward: removed }], redo: [], lastCommit: snap(b) });
    // c 의 기록은 이미 씬과 어긋나 있다(다른 탭 편집 등) — 원래대로 건드리지 않는다
    const stale = { undo: [snap(c)], redo: [], lastCommit: { ...snap(c), cards: [] } };
    saveSceneHistory(c.id, stale);
    locate.mockResolvedValue(answer({ fixed: [{ token: "asset:imports|a.png", project: "P", path: "CH/a.png" }] }));

    await relinkSceneAssetRefs({ applyToBoard: () => null });

    const after = listScenes(null).find((s) => s.id === b.id)!;
    const history = loadSceneHistory(b.id)!;
    expect(sameSnap(history.lastCommit, snap(after))).toBe(true); // 돌아가면 restoreSceneHistory 가 기록을 잇는다
    expect(history.undo[0].cards[0].refs![0].file_path).toBe("asset:P|CH/a.png");
    expect(history.undo[0].removedForward).toEqual(removed);
    expect(loadSceneHistory(c.id)).toBe(stale);
  });

  it("캔버스가 안 열렸으면 활성 씬도 저장 직후 통째로 받는다(boardApplied=false)", async () => {
    await saveScenes(null, [scene([{ file_path: "asset:imports|b.png" }])]);
    locate.mockResolvedValue({
      fixed: [{ token: "asset:imports|b.png", project: "P", path: "CH/b.png" }],
      unresolved: [],
      missing: [],
      local: [],
    });
    const onSaved = vi.fn();
    expect(await relinkSceneAssetRefs({ applyToBoard: () => null, onSaved })).toBe(1);
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onSaved.mock.calls[0][1]).toBe(false);
  });

  it("중간에 실패해도 이미 받은 답은 화면·저장소에 남고, 그만큼을 돌려준다(2026-09-29)", async () => {
    // 첫 배치가 고친 뒤, 도는 동안 새 참조가 생겨 다음 바퀴에서 묻다가 서버가 실패한다
    await saveScenes(null, [scene([{ file_path: "asset:imports|first.png" }])]);
    locate
      .mockImplementationOnce(async () => {
        await saveScenes(null, [
          ...listScenes(null),
          { ...scene([{ file_path: "asset:imports|second.png" }]), id: "s2" },
        ]);
        return {
          fixed: [{ token: "asset:imports|first.png", project: "P", path: "CH/first.png" }],
          unresolved: [],
          missing: [],
          local: [],
        };
      })
      .mockRejectedValueOnce(new Error("NAS 멈춤"));
    const onSaved = vi.fn();

    expect(await relinkSceneAssetRefs({ onSaved })).toBe(1);
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(listScenes(null)[0].cards[0].refs![0].file_path).toBe("asset:P|CH/first.png");
  });

  it("멈춘 NAS 에 영원히 매달리지 않게 요청마다 시간 한도(AbortSignal)를 건다(2026-09-29)", async () => {
    await saveScenes(null, [scene([{ file_path: "asset:imports|slow.png" }])]);
    locate.mockResolvedValue({ fixed: [], unresolved: [], missing: [], local: [] });
    await relinkSceneAssetRefs();
    expect(locate.mock.calls[0][4]).toBeInstanceOf(AbortSignal);
  });

  it("서버가 실패하면 삼키고, 다음 기회에 다시 묻는다", async () => {
    await saveScenes(null, [scene([{ file_path: "asset:imports|retry.png" }])]);
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
  beforeEach(async () => {
    localStorage.clear();
    resetRelinkSessionForTest();
    locate.mockReset();
  });

  it("서버 답의 missing·local 을 그 공간의 참조에만 기억하고, 바뀌면 한 번 알린다", async () => {
    await saveScenes(null, [
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
      open: ["asset:P|ok.png"],
    });
    const heard = vi.fn();
    const off = subscribeRefServerStatus(heard);
    const before = getRefServerStatusVersion();

    await relinkSceneAssetRefs();
    off();

    expect(status("ws-s", "asset:Q|gone.png")).toBe("missing");
    expect(status("ws-s", "asset:imports|mine.png")).toBe("local");
    expect(status("ws-s", "asset:P|ok.png")).toBeUndefined(); // 열리는 것은 표시 없음
    expect(status("", "asset:Q|gone.png")).toBeUndefined(); // 다른 공간의 씬에는 번지지 않는다
    expect(getRefServerStatusVersion()).toBe(before + 1);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("앱을 다시 켜도 저장된 판정은 다시 묻지 않고, '레퍼런스 찾기'가 다시 물어 표시를 고친다", async () => {
    await saveScenes(null, [scene([{ file_path: "asset:Q|later.png" }])]);
    locate.mockResolvedValue(answer({ unresolved: ["asset:Q|later.png"], missing: ["asset:Q|later.png"] }));
    await relinkSceneAssetRefs();
    expect(status("", "asset:Q|later.png")).toBe("missing");

    resetRelinkSessionForTest(); // 앱을 다시 켬
    await relinkSceneAssetRefs();
    expect(locate).toHaveBeenCalledTimes(1);
    expect(status("", "asset:Q|later.png")).toBe("missing"); // 새로 켜도 표시는 기억에서 바로 나온다

    // NAS 에 나중에 올렸다 — 단추가 다시 묻는다
    locate.mockResolvedValue(answer({ unresolved: ["asset:Q|later.png"], open: ["asset:Q|later.png"] }));
    const summary = await findSceneAssetRefs("s1", {});
    expect(locate).toHaveBeenCalledTimes(2);
    expect(summary).toMatchObject({ asked: 1, open: 1, missing: 0, aborted: false });
    expect(status("", "asset:Q|later.png")).toBeUndefined();
  });
});

describe("방금 이 PC 에 넣은 참조(2026-09-29 옛 방식)", () => {
  beforeEach(async () => {
    localStorage.clear();
    resetRelinkSessionForTest();
    locate.mockReset();
  });

  it("서버 답 전에는 '이 PC에만'을 켜지 않는다 — 판정은 서버가 한다(2026-09-29)", async () => {
    const heard = vi.fn();
    const off = subscribeRefServerStatus(heard);
    forceRefsAsk("ws-m", ["asset:imports|dropped.png"]);
    expect(status("ws-m", "asset:imports|dropped.png")).toBeUndefined();
    expect(heard).not.toHaveBeenCalled(); // 예전에는 NAS 에 있는 파일도 답이 올 때까지 빨갛게 보였다

    await saveScenes(null, [scene([{ file_path: "asset:imports|dropped.png" }], { id: "ws-m", name: "가" })]);
    locate.mockResolvedValue({
      fixed: [],
      unresolved: ["asset:imports|dropped.png"],
      missing: [],
      local: ["asset:imports|dropped.png"],
    });
    await relinkSceneAssetRefs();
    off();
    expect(status("ws-m", "asset:imports|dropped.png")).toBe("local"); // 서버가 확인한 뒤에만
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("같은 파일을 다시 끌어다 놓으면 저장된 판정과 무관하게 다시 물어 원본으로 잇는다(Codex)", async () => {
    const token = "asset:imports|again.png";
    locate.mockResolvedValue({
      fixed: [{ token, project: "P", path: "BG/again.png" }],
      unresolved: [],
      missing: [],
      local: [],
    });
    await saveScenes(null, [scene([{ file_path: token }], { id: "ws-a", name: "가" })]);
    forceRefsAsk("ws-a", [token]);
    expect(await relinkSceneAssetRefs()).toBe(1);

    // 곧바로 같은 파일을 다시 끌어다 놓음 — 같은 이 PC 사본 토큰이 다시 생긴다(판정은 fixed 로 기억돼 있다)
    await saveScenes(null, [scene([{ file_path: token }], { id: "ws-a", name: "가" })]);
    forceRefsAsk("ws-a", [token]);
    expect(await relinkSceneAssetRefs()).toBe(1);
    expect(locate).toHaveBeenCalledTimes(2);
  });

  it("도는 중에 또 불리면 끝난 뒤 한 번 더 돈다 — 마지막 바퀴 뒤에 들어온 참조도 놓치지 않는다(Codex)", async () => {
    const tokens = Array.from({ length: 8 }, (_, i) => `asset:Q|drop${i}.png`);
    let shown = 1;
    await saveScenes(null, [scene([{ file_path: tokens[0] }])]);
    locate.mockImplementation(async () => {
      await Promise.resolve(); // 실제 요청처럼 한 박자 뒤에 답한다 — 그 사이 '도는 중' 표시가 잡혀 있다
      // 물을 때마다 새 참조가 하나씩 생기고(끌어다 놓기) 그때마다 다시 부른다 — 도는 중이라 합쳐진다
      if (shown < tokens.length) {
        shown += 1;
        await saveScenes(null, [scene(tokens.slice(0, shown).map((file_path) => ({ file_path })))]);
        void relinkSceneAssetRefs();
      }
      return { fixed: [], unresolved: [], missing: [], local: [] };
    });

    await relinkSceneAssetRefs();

    const asked = new Set(locate.mock.calls.flatMap((call) => call[0] as string[]));
    expect(tokens.filter((token) => !asked.has(token))).toEqual([]); // 한 번에 다섯 바퀴를 넘어도 끝까지 물었다
  });
});

describe("판정 기억(Jay 2026-09-29 '2 새 안')", () => {
  beforeEach(async () => {
    localStorage.clear();
    sessionStorage.clear();
    resetRelinkSessionForTest();
    locate.mockReset();
  });

  it("앱을 다시 켜면 판정을 받은 참조는 묻지 않고, 판정을 못 끝낸 것·새 참조만 묻는다", async () => {
    const tokens = [
      "asset:P|open.png",
      "asset:Q|gone.png",
      "asset:imports|nas-down.png",
      "asset:imports|twice.png",
      "asset:imports|found.png",
    ];
    await saveScenes(null, [scene(tokens.map((file_path) => ({ file_path })))]);
    locate.mockResolvedValueOnce(
      answer({
        fixed: [{ token: "asset:imports|found.png", project: "P", path: "CH/found.png" }],
        unresolved: tokens.slice(0, 4),
        open: ["asset:P|open.png"],
        missing: ["asset:Q|gone.png"],
        incomplete: ["asset:imports|nas-down.png"],
      }),
    );
    await relinkSceneAssetRefs();
    expect(locate).toHaveBeenCalledTimes(1);

    await relinkSceneAssetRefs(); // 같은 세션 — 판정을 못 끝낸 것도 다음 앱 시작까지 다시 묻지 않는다
    expect(locate).toHaveBeenCalledTimes(1);

    resetRelinkSessionForTest(); // 앱을 다시 켬 + 새 참조 하나
    const [saved] = listScenes(null);
    await saveScenes(null, [
      {
        ...saved,
        cards: [
          ...saved.cards,
          { id: "c9", kind: "reference", x: 0, y: 0, refs: [{ type: "image", file_path: "asset:imports|new.png" }] },
        ],
      } as Scene,
    ]);
    locate.mockResolvedValueOnce(answer({ unresolved: ["asset:imports|nas-down.png", "asset:imports|new.png"] }));
    await relinkSceneAssetRefs();
    expect(locate).toHaveBeenCalledTimes(2);
    // 열림·없음·후보 여럿(판정 끝)·원본으로 이어진 새 토큰은 묻지 않는다
    expect(locate.mock.calls[1][0]).toEqual(["asset:imports|nas-down.png", "asset:imports|new.png"]);
  });

  it("씬 파일·백업으로 들어온 씬은 저장된 판정과 무관하게 한 번 묻는다", async () => {
    await saveScenes(null, [scene([{ file_path: "asset:Q|known.png" }])]);
    locate.mockResolvedValue(answer({ unresolved: ["asset:Q|known.png"], missing: ["asset:Q|known.png"] }));
    await relinkSceneAssetRefs();
    resetRelinkSessionForTest();
    await relinkSceneAssetRefs();
    expect(locate).toHaveBeenCalledTimes(1); // 저장된 판정 — 안 묻는다

    forceSceneRefsAsk(listScenes(null)); // 이 씬이 방금 들어왔다
    await relinkSceneAssetRefs();
    expect(locate).toHaveBeenCalledTimes(2);
    await relinkSceneAssetRefs(); // 강제는 한 번뿐
    expect(locate).toHaveBeenCalledTimes(2);
  });

  it("계정마다 따로 기억한다 — 다른 계정의 판정으로 건너뛰거나 표시하지 않는다", async () => {
    try {
      setAccountScope("a@team");
      await saveScenes(null, [scene([{ file_path: "asset:Q|acct.png" }])]);
      locate.mockResolvedValue(answer({ unresolved: ["asset:Q|acct.png"], missing: ["asset:Q|acct.png"] }));
      await relinkSceneAssetRefs();
      expect(status("", "asset:Q|acct.png")).toBe("missing");

      setAccountScope("b@team");
      expect(status("", "asset:Q|acct.png")).toBeUndefined();
      await saveScenes(null, [scene([{ file_path: "asset:Q|acct.png" }])]);
      resetRelinkSessionForTest();
      await relinkSceneAssetRefs();
      expect(locate).toHaveBeenCalledTimes(2); // 다른 계정은 자기 판정이 없어 다시 묻는다

      setAccountScope("a@team");
      expect(status("", "asset:Q|acct.png")).toBe("missing"); // 앞 계정의 칸은 그대로
    } finally {
      setAccountScope("");
    }
  });

  it("한 토큰의 참조들이 지문이 다르면 지문 없는 열쇠로 기억하고, 각 참조의 지문으로도 찾는다", async () => {
    const a = { content_sha: "a".repeat(64), bytes: 1 };
    const b = { content_sha: "b".repeat(64), bytes: 2 };
    await saveScenes(null, [scene([{ file_path: "asset:imports|x.png", ...a }, { file_path: "asset:imports|x.png", ...b }])]);
    locate.mockResolvedValue(answer({ unresolved: ["asset:imports|x.png"], local: ["asset:imports|x.png"] }));
    await relinkSceneAssetRefs();
    expect(locate.mock.calls[0][3]).toEqual({}); // 지문이 달라 싣지 않았다
    expect(status("", "asset:imports|x.png", a)).toBe("local");
    expect(status("", "asset:imports|x.png", b)).toBe("local");
  });

  it("지금 씬들이 쓰지 않는 판정은 다음 복구 때 버린다", async () => {
    await saveScenes(null, [scene([{ file_path: "asset:Q|old.png" }])]);
    locate.mockResolvedValue(answer({ unresolved: ["asset:Q|old.png"], missing: ["asset:Q|old.png"] }));
    await relinkSceneAssetRefs();
    expect(storedKeys()).toHaveLength(1);

    await saveScenes(null, []); // 그 씬을 지웠다
    await relinkSceneAssetRefs();
    expect(storedKeys()).toHaveLength(0);
  });

  it("다른 탭이 바꾼 판정을 다시 읽고, 이 탭이 저장할 때도 더 나중 판정을 지킨다", async () => {
    await saveScenes(null, [scene([{ file_path: "asset:Q|tab.png" }])]);
    locate.mockResolvedValue(answer({ unresolved: ["asset:Q|tab.png"], missing: ["asset:Q|tab.png"] }));
    await relinkSceneAssetRefs();
    expect(status("", "asset:Q|tab.png")).toBe("missing");

    // 다른 탭이 같은 참조를 더 나중에 '이 PC 에만'으로 확인했다
    const all = JSON.parse(localStorage.getItem(STORAGE_KEYS.sceneRefVerdicts)!);
    for (const key of Object.keys(all.local)) all.local[key] = ["local", Date.now() + 1000];
    localStorage.setItem(STORAGE_KEYS.sceneRefVerdicts, JSON.stringify(all));
    const heard = vi.fn();
    const off = subscribeRefServerStatus(heard);
    window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEYS.sceneRefVerdicts }));
    off();
    expect(heard).toHaveBeenCalledTimes(1);
    expect(status("", "asset:Q|tab.png")).toBe("local");

    // 이 탭이 다른 참조의 판정을 저장해도(합치기) 더 나중 판정은 남는다
    await saveScenes(null, [scene([{ file_path: "asset:Q|tab.png" }, { file_path: "asset:Q|other.png" }])]);
    locate.mockResolvedValue(answer({ unresolved: ["asset:Q|other.png"], missing: ["asset:Q|other.png"] }));
    await relinkSceneAssetRefs();
    expect(status("", "asset:Q|tab.png")).toBe("local");
    expect(status("", "asset:Q|other.png")).toBe("missing");
  });

  it("묻는 사이 계정이 바뀌면 그 답은 버린다 — 옛 계정 폴더의 답을 새 계정 씬·판정에 쓰지 않게(Codex)", async () => {
    try {
      for (const account of ["b@team", "a@team"]) {
        setAccountScope(account);
        await saveScenes(null, [scene([{ file_path: "asset:imports|acct.png" }])]);
      }
      locate.mockImplementation(async () => {
        setAccountScope("b@team"); // 답이 오기 전에 다른 계정으로 바뀌었다
        return answer({ fixed: [{ token: "asset:imports|acct.png", project: "P", path: "CH/acct.png" }] });
      });
      expect(await relinkSceneAssetRefs()).toBe(0);
      expect(listScenes(null)[0].cards[0].refs![0].file_path).toBe("asset:imports|acct.png"); // B 의 씬은 그대로
      expect(storedKeys("acct:b@team")).toEqual([]);
      setAccountScope("a@team");
      expect(listScenes(null)[0].cards[0].refs![0].file_path).toBe("asset:imports|acct.png"); // A 도 — 답을 버렸다
      expect(storedKeys("acct:a@team")).toEqual([]);
    } finally {
      setAccountScope("");
    }
  });

  it("강제로 다시 물었는데 판정을 못 끝내면 옛 판정을 지워 다음 시작에 다시 묻는다(Codex)", async () => {
    await saveScenes(null, [scene([{ file_path: "asset:imports|re.png" }])]);
    locate.mockResolvedValueOnce(answer({ unresolved: ["asset:imports|re.png"], local: ["asset:imports|re.png"] }));
    await relinkSceneAssetRefs();
    expect(status("", "asset:imports|re.png")).toBe("local");

    forceRefsAsk("", ["asset:imports|re.png"]); // 같은 파일을 다시 넣었는데 NAS 가 끊겼다
    locate.mockResolvedValueOnce(answer({ unresolved: ["asset:imports|re.png"], incomplete: ["asset:imports|re.png"] }));
    await relinkSceneAssetRefs();
    expect(status("", "asset:imports|re.png")).toBe("incomplete"); // 옛 '이 PC 에만'은 지우고, 이번 실행엔 회색 '확인 못 함'

    resetRelinkSessionForTest();
    locate.mockResolvedValueOnce(answer({ unresolved: ["asset:imports|re.png"], local: ["asset:imports|re.png"] }));
    await relinkSceneAssetRefs();
    expect(locate).toHaveBeenCalledTimes(3); // 다음 시작에 다시 물었다
  });

  it("원본으로 이었다는 판정은 씬 저장이 된 뒤에만 기억한다 — 저장 실패면 다음에 다시 묻는다(Codex)", async () => {
    await saveScenes(null, [scene([{ file_path: "asset:imports|nospace.png" }])]);
    failSceneStoreWritesForTest(true); // 씬 저장만 실패(저장소는 IndexedDB — localStorage 가로채기로는 못 만든다)
    const full = { mockRestore: () => failSceneStoreWritesForTest(false) };
    locate.mockResolvedValue(answer({ fixed: [{ token: "asset:imports|nospace.png", project: "P", path: "CH/n.png" }] }));
    try {
      expect(await relinkSceneAssetRefs()).toBe(0);
    } finally {
      full.mockRestore();
    }
    expect(listScenes(null)[0].cards[0].refs![0].file_path).toBe("asset:imports|nospace.png");

    resetRelinkSessionForTest();
    await relinkSceneAssetRefs();
    expect(locate).toHaveBeenCalledTimes(2); // fixed 를 기억하지 않아 다시 물었다 — 이번엔 저장된다
    expect(listScenes(null)[0].cards[0].refs![0].file_path).toBe("asset:P|CH/n.png");
  });

  it("5,000건을 넘으면 오래 확인한 것부터 버린다", async () => {
    const tokens = Array.from({ length: 5050 }, (_, i) => `asset:Q|many/${i}.png`);
    await saveScenes(null, [scene(tokens.map((file_path) => ({ file_path })))]);
    locate.mockImplementation(async (batch: string[]) => answer({ unresolved: batch }));
    await relinkSceneAssetRefs();
    expect(locate).toHaveBeenCalledTimes(26);
    expect(storedKeys()).toHaveLength(5000);
  });

  it("옛 서버 답(open·incomplete 없음)에도, 망가진 저장값에도 복구는 돈다", async () => {
    localStorage.setItem(STORAGE_KEYS.sceneRefVerdicts, "{망가짐");
    await saveScenes(null, [scene([{ file_path: "asset:P|x.png" }])]);
    locate.mockResolvedValue({ fixed: [], unresolved: ["asset:P|x.png"], missing: [], local: [] });
    await relinkSceneAssetRefs();
    resetRelinkSessionForTest();
    await relinkSceneAssetRefs();
    expect(locate).toHaveBeenCalledTimes(1); // 옛 서버의 미해결도 '판정 끝'으로 기억했다
  });
});

describe("레퍼런스 찾기 단추(Jay 2026-09-29)", () => {
  beforeEach(async () => {
    localStorage.clear();
    resetRelinkSessionForTest();
    locate.mockReset();
  });

  it("이 씬만, render 까지, 새 작업 id 로, 저장된 판정과 무관하게 묻고 한 줄로 알린다", async () => {
    const s1 = { ...scene([{ file_path: "asset:imports|a.png" }, { file_path: "asset:Q|b.png" }]), id: "s1" };
    const s2 = { ...scene([{ file_path: "asset:Q|other.png" }]), id: "s2" };
    await saveScenes(null, [s1, s2]);
    locate.mockResolvedValueOnce(
      answer({
        unresolved: ["asset:imports|a.png", "asset:Q|b.png", "asset:Q|other.png"],
        local: ["asset:imports|a.png"],
        missing: ["asset:Q|b.png", "asset:Q|other.png"],
      }),
    );
    await relinkSceneAssetRefs();
    const autoScan = locate.mock.calls[0][2];

    locate.mockResolvedValueOnce(
      answer({
        fixed: [{ token: "asset:imports|a.png", project: "P", path: "Render/a.png" }],
        unresolved: ["asset:Q|b.png"],
        missing: ["asset:Q|b.png"],
      }),
    );
    const onSaved = vi.fn();
    const summary = await findSceneAssetRefs("s1", { onSaved });

    expect(locate).toHaveBeenCalledTimes(2);
    const [tokens, , scanId, , , includeRender] = locate.mock.calls[1];
    expect(tokens).toEqual(["asset:imports|a.png", "asset:Q|b.png"]); // 이 씬만
    expect(includeRender).toBe(true);
    expect(scanId).not.toBe(autoScan); // 폴더를 새로 훑는다 — 나중에 올린 파일도 찾게
    expect(summary).toMatchObject({ asked: 2, fixed: 1, missing: 1, local: 0, aborted: false });
    expect(findSummaryText(summary)).toBe(
      "레퍼런스 찾기 끝 — 원본 연결 1 · 이 PC에만 0 · 서버에 없음 1 · 판정 보류 0",
    );
    expect(listScenes(null).find((s) => s.id === "s1")!.cards[0].refs![0].file_path).toBe("asset:P|Render/a.png");
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("자동 복구가 도는 중에 누르면 끝난 뒤에 돈다 — 늦게 온 답이 새 답을 덮지 않게(Codex)", async () => {
    await saveScenes(null, [scene([{ file_path: "asset:Q|slow.png" }])]);
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const order: string[] = [];
    locate.mockImplementation(async (...args: unknown[]) => {
      const includeRender = args[5] === true;
      order.push(includeRender ? "find" : "auto");
      if (!includeRender) await gate;
      return includeRender
        ? answer({ unresolved: ["asset:Q|slow.png"], open: ["asset:Q|slow.png"] })
        : answer({ unresolved: ["asset:Q|slow.png"], missing: ["asset:Q|slow.png"] });
    });

    const auto = relinkSceneAssetRefs();
    const find = findSceneAssetRefs("s1", {});
    await vi.waitFor(() => expect(order).toEqual(["auto"]));
    release();
    await auto;
    await find;

    expect(order).toEqual(["auto", "find"]);
    expect(status("", "asset:Q|slow.png")).toBeUndefined(); // 단추의 답(열림)이 마지막 — 자동의 '없음'이 덮지 않았다
  });

  it("이미 도는 자동 복구는 끊고 앞선다 — 멈춘 NAS 에 걸린 자동 요청 뒤에 5분 줄 서지 않는다(Codex P1 2026-09-30)", async () => {
    await saveScenes(null, [scene([{ file_path: "asset:Q|stuck.png" }])]);
    locate.mockImplementationOnce(
      (...args: unknown[]) =>
        new Promise((_, reject) => (args[4] as AbortSignal).addEventListener("abort", () => reject(new Error("aborted")))),
    );
    const auto = relinkSceneAssetRefs();
    await vi.waitFor(() => expect(locate).toHaveBeenCalledTimes(1));
    locate.mockResolvedValueOnce(answer({ unresolved: ["asset:Q|stuck.png"], missing: ["asset:Q|stuck.png"] }));

    const summary = await findSceneAssetRefs("s1", {});
    await auto;
    expect(locate).toHaveBeenCalledTimes(2);
    expect(summary).toMatchObject({ missing: 1, aborted: false });
    expect(status("", "asset:Q|stuck.png")).toBe("missing");
  });

  it("끊은 자동 복구가 다음 바퀴로 미뤄 둔 참조는 단추 뒤에 자동 복구가 한 번 더 돌아 묻는다(Codex P1 재검토)", async () => {
    const s1 = { ...scene([{ file_path: "asset:Q|stuck.png" }]), id: "s1" };
    await saveScenes(null, [s1]);
    locate.mockImplementation((...args: unknown[]) => {
      const tokens = args[0] as string[];
      if (tokens.includes("asset:Q|new.png")) return Promise.resolve(answer({ open: ["asset:Q|new.png"] }));
      if (args[5] === true) return Promise.resolve(answer({ open: ["asset:Q|stuck.png"] }));
      return new Promise((_, reject) => (args[4] as AbortSignal).addEventListener("abort", () => reject(new Error("aborted"))));
    });
    const auto = relinkSceneAssetRefs();
    await vi.waitFor(() => expect(locate).toHaveBeenCalledTimes(1));
    // 도는 중에 다른 씬에 새 참조가 들어와 자동 복구를 또 부른다 → 다음 바퀴 예약
    await saveScenes(null, [s1, { ...scene([{ file_path: "asset:Q|new.png" }]), id: "s2" }]);
    void relinkSceneAssetRefs();

    await findSceneAssetRefs("s1", {});
    await auto;
    await vi.waitFor(() => expect(locate.mock.calls.some((c) => (c[0] as string[]).includes("asset:Q|new.png"))).toBe(true));
  });

  it("대기 중단 — 기다리기를 멈추고, 멈춘 배치의 답은 기억하지 않는다", async () => {
    await saveScenes(null, [scene([{ file_path: "asset:Q|stuck.png" }])]);
    locate.mockImplementation(
      (...args: unknown[]) =>
        new Promise((_resolve, reject) => {
          const signal = args[4] as AbortSignal;
          signal.addEventListener("abort", () => reject(signal.reason));
        }),
    );
    const ctrl = new AbortController();
    const find = findSceneAssetRefs("s1", {}, ctrl.signal);
    await vi.waitFor(() => expect(locate).toHaveBeenCalledTimes(1));
    ctrl.abort();
    const summary = await find;

    expect(summary.aborted).toBe(true);
    expect(findSummaryText(summary)).toContain("기다리기를 멈췄습니다");
    // 기억하지 않았다 — 앱을 다시 켜면 자동 복구가 다시 묻는다
    resetRelinkSessionForTest();
    locate.mockReset();
    locate.mockResolvedValue(answer({ unresolved: ["asset:Q|stuck.png"] }));
    await relinkSceneAssetRefs();
    expect(locate).toHaveBeenCalledTimes(1);
  });

  it("찾을 참조가 없으면 묻지 않고, 서버 실패는 던진다(부르는 쪽이 알린다)", async () => {
    await saveScenes(null, [scene([])]);
    const none = await findSceneAssetRefs("s1", {});
    expect(locate).not.toHaveBeenCalled();
    expect(findSummaryText(none)).toBe("이 씬에는 찾을 레퍼런스가 없습니다.");

    await saveScenes(null, [scene([{ file_path: "asset:Q|x.png" }])]);
    locate.mockRejectedValue(new Error("서버 없음"));
    await expect(findSceneAssetRefs("s1", {})).rejects.toThrow("서버 없음");
  });

  it("모두 열리면 그렇게, 판정 보류는 끝까지 못 훑은 것까지 센다", async () => {
    const base = { asked: 3, open: 3, fixed: 0, local: 0, missing: 0, unresolved: 0, incomplete: 0, aborted: false };
    expect(findSummaryText(base)).toBe("레퍼런스 3개가 모두 원본과 이어져 있습니다.");
    expect(findSummaryText({ ...base, open: 1, unresolved: 1, incomplete: 1 })).toBe(
      "레퍼런스 찾기 끝 — 원본 연결 0 · 이 PC에만 0 · 서버에 없음 0 · 판정 보류 2",
    );
  });
});

describe("에셋 대장 번호(2026-09-30)", () => {
  const OLD = "a".repeat(64);
  const NEW = "b".repeat(64);

  beforeEach(async () => {
    localStorage.clear();
    resetRelinkSessionForTest();
    locate.mockReset();
  });

  it("한 토큰의 참조가 모두 같은 번호일 때만 번호를 싣는다(Codex — 다른 번호끼리 한 답을 나눠 갖지 않게)", async () => {
    const [group] = sceneAssetGroups([
      scene([
        { file_path: "asset:P|a.png", registry_asset_id: "r1" },
        { file_path: "asset:P|b.png", registry_asset_id: "r2" },
        { file_path: "asset:P|c.png", registry_asset_id: "r3" },
      ]),
      scene([
        { file_path: "asset:P|a.png", registry_asset_id: "r1" },
        { file_path: "asset:P|b.png" }, // 번호 없는 옛 참조가 같은 토큰을 쓴다
        { file_path: "asset:P|c.png", registry_asset_id: "r9" },
      ]),
    ]);
    expect(group.registryIds).toEqual({ "asset:P|a.png": "r1" });
  });

  it("번호가 같으면 넣을 때 판과 달라도 새 자리로 따라가고, 넣을 때 판은 지킨다", async () => {
    const cards = scene([{ file_path: "asset:P|CH/x.png", thumb: "t", content_sha: OLD, bytes: 1, registry_asset_id: "r1" }])
      .cards;
    const found = new Map([
      [relinkKey("", "asset:P|CH/x.png"), { project: "P", path: "CH/old/x_v2.png", sha256: NEW, bytes: 2, registry_asset_id: "r1" }],
    ]);
    const { cards: next, changed } = relinkCards(cards, "", found);
    expect(changed).toBe(1);
    expect(next[0].refs?.[0]).toMatchObject({
      file_path: "asset:P|CH/old/x_v2.png",
      thumb: null,
      content_sha: OLD,
      bytes: 1,
      registry_asset_id: "r1",
    });
  });

  it("번호가 있는 참조는 다른 번호·번호 없는 답을 받지 않는다", async () => {
    const cards = scene([{ file_path: "asset:P|CH/x.png", registry_asset_id: "r1" }]).cards;
    for (const hit of [
      { project: "P", path: "CH/y.png", registry_asset_id: "r2" },
      { project: "P", path: "CH/y.png" },
    ]) {
      const { changed } = relinkCards(cards, "", new Map([[relinkKey("", "asset:P|CH/x.png"), hit]]));
      expect(changed).toBe(0);
    }
  });

  it("열리는 참조에는 번호만 붙이고 썸네일·주소는 그대로 둔다 — 이미 번호가 있으면 덮지 않는다", async () => {
    const cards = scene([
      { file_path: "asset:P|a.png", thumb: "keep" },
      { file_path: "asset:P|b.png", thumb: "keep", registry_asset_id: "mine" },
    ]).cards;
    const found = new Map([
      [relinkKey("", "asset:P|a.png"), { project: "P", path: "a.png", registry_asset_id: "r1" }],
      [relinkKey("", "asset:P|b.png"), { project: "P", path: "b.png", registry_asset_id: "other" }],
    ]);
    const { cards: next, changed } = relinkCards(cards, "", found);
    expect(changed).toBe(1);
    expect(next[0].refs?.[0]).toMatchObject({ file_path: "asset:P|a.png", thumb: "keep", registry_asset_id: "r1" });
    expect(next[0].refs?.[1]).toMatchObject({ registry_asset_id: "mine" });
  });

  it("서버가 알려 준 번호(open_ids)를 씬에 저장하고, 다음 복구는 다시 묻지 않는다 — 원본 연결 수에는 넣지 않는다", async () => {
    await saveScenes(null, [scene([{ file_path: "asset:P|a.png" }])]);
    locate.mockResolvedValue(answer({ open: ["asset:P|a.png"], open_ids: { "asset:P|a.png": "r1" } }));

    expect(await relinkSceneAssetRefs()).toBe(0);
    expect(listScenes(null)[0].cards[0].refs?.[0].registry_asset_id).toBe("r1");

    resetRelinkSessionForTest(); // 앱을 다시 켠 것처럼
    await relinkSceneAssetRefs();
    expect(locate).toHaveBeenCalledTimes(1); // 번호 열쇠로 '열림'을 기억했다
  });

  it("번호 저장이 실패하면 '열림'도 기억하지 않아 다음에 다시 묻는다(Codex P1)", async () => {
    await saveScenes(null, [scene([{ file_path: "asset:P|a.png" }])]);
    failSceneStoreWritesForTest(true); // 씬 저장만 실패(저장소는 IndexedDB — localStorage 가로채기로는 못 만든다)
    const full = { mockRestore: () => failSceneStoreWritesForTest(false) };
    locate.mockResolvedValue(answer({ open: ["asset:P|a.png"], open_ids: { "asset:P|a.png": "r1" } }));
    try {
      await relinkSceneAssetRefs();
    } finally {
      full.mockRestore();
    }
    expect(listScenes(null)[0].cards[0].refs?.[0].registry_asset_id).toBeUndefined();

    resetRelinkSessionForTest();
    await relinkSceneAssetRefs();
    expect(locate).toHaveBeenCalledTimes(2); // 다시 물었다 — 이번엔 번호가 저장된다
    expect(listScenes(null)[0].cards[0].refs?.[0].registry_asset_id).toBe("r1");
  });

  it("번호가 붙은 참조는 번호를 함께 보낸다", async () => {
    await saveScenes(null, [scene([{ file_path: "asset:P|a.png", registry_asset_id: "r1" }, { file_path: "asset:P|b.png" }])]);
    locate.mockResolvedValue(answer({}));
    await relinkSceneAssetRefs();
    expect(locate.mock.calls[0][6]).toEqual({ "asset:P|a.png": "r1" });
  });
});

describe("탭에 공간이 없으면 지금 선택된 워크스페이스로 찾는다(Jay 2026-09-30)", () => {
  beforeEach(async () => {
    localStorage.clear();
    resetRelinkSessionForTest();
    locate.mockReset();
  });

  it("공간 없는 탭은 선택된 팀 공간을 싣고, 판정·연결 열쇠는 그대로 탭 기준이다", async () => {
    localStorage.setItem(STORAGE_KEYS.workspaceContext, JSON.stringify({ scope: "team", id: "ws-mudx", name: "뻘뻘뻘" }));
    await saveScenes(null, [scene([{ file_path: "asset:뻘뻘뻘_RnD|CH/m/a.png" }])]);
    locate.mockResolvedValue(
      answer({ fixed: [{ token: "asset:뻘뻘뻘_RnD|CH/m/a.png", project: "뻘뻘뻘", path: "assets/CH/m/a.png" }] }),
    );
    await findSceneAssetRefs("s1", {});
    expect(locate.mock.calls[0][1]).toBe("ws-mudx");
    expect(listScenes(null)[0].cards[0].refs?.[0].file_path).toBe("asset:뻘뻘뻘|assets/CH/m/a.png"); // 빈 공간 열쇠로 적용됐다
  });

  it("탭에 공간이 있으면 그 공간이 먼저다 — 선택이 개인·미정이면 싣지 않는다", async () => {
    localStorage.setItem(STORAGE_KEYS.workspaceContext, JSON.stringify({ scope: "team", id: "ws-other", name: "다른 곳" }));
    await saveScenes(null, [scene([{ file_path: "asset:P|x/a.png" }], { id: "ws-tab", name: "탭" })]);
    locate.mockResolvedValue(answer({ unresolved: ["asset:P|x/a.png"] }));
    await findSceneAssetRefs("s1", {});
    expect(locate.mock.calls[0][1]).toBe("ws-tab");

    localStorage.setItem(STORAGE_KEYS.workspaceContext, JSON.stringify({ scope: "personal" }));
    await saveScenes(null, [scene([{ file_path: "asset:P|x/a.png" }])]);
    await findSceneAssetRefs("s1", {});
    expect(locate.mock.calls[1][1]).toBe("");
  });
});

describe("'보류' 판정은 물을 때 실은 공간과 함께 기억한다(Codex P2 2026-09-30)", () => {
  beforeEach(async () => {
    localStorage.clear();
    resetRelinkSessionForTest();
    locate.mockReset();
  });

  const pick = (id: string) =>
    localStorage.setItem(STORAGE_KEYS.workspaceContext, JSON.stringify({ scope: "team", id, name: id }));

  it("선택 공간을 바꾸면 자동 복구가 보류를 다시 묻고, 같은 공간이면 다시 안 묻는다 — 서버에 없음은 공간과 무관하다", async () => {
    pick("ws-B");
    await saveScenes(null, [scene([{ file_path: "asset:뻘뻘뻘_RnD|CH/m/a.png" }, { file_path: "asset:imports|gone.png" }])]);
    locate.mockResolvedValue(
      answer({ unresolved: ["asset:뻘뻘뻘_RnD|CH/m/a.png", "asset:imports|gone.png"], missing: ["asset:imports|gone.png"] }),
    );
    await relinkSceneAssetRefs();
    expect(locate).toHaveBeenCalledTimes(1);

    resetRelinkSessionForTest(); // 앱을 다시 켬 — 같은 공간이면 기억으로 끝
    await relinkSceneAssetRefs();
    expect(locate).toHaveBeenCalledTimes(1);

    pick("ws-A"); // 다른 공간을 고르고 다시 켬 → 보류만 다시 묻는다
    resetRelinkSessionForTest();
    locate.mockResolvedValue(answer({ unresolved: ["asset:뻘뻘뻘_RnD|CH/m/a.png"] }));
    await relinkSceneAssetRefs();
    expect(locate).toHaveBeenCalledTimes(2);
    expect(locate.mock.calls[1][0]).toEqual(["asset:뻘뻘뻘_RnD|CH/m/a.png"]);
    expect(locate.mock.calls[1][1]).toBe("ws-A");
    expect(status("", "asset:imports|gone.png")).toBe("missing"); // 서버에 없음 표시는 그대로
  });
});

describe("연결 안 된 레퍼런스 표시(Jay 2026-09-30 시안 — 보류도 빨강 + 이유)", () => {
  beforeEach(async () => {
    localStorage.clear();
    resetRelinkSessionForTest();
    locate.mockReset();
  });

  it("보류는 이유와 함께 기억하고, 판정 전·판정 못 끝냄은 따로 구별한다", async () => {
    await saveScenes(null, [
      scene([
        { file_path: "asset:뻘뻘뻘_RnD|CH/m/a.png" },
        { file_path: "asset:imports|copy.png" },
        { file_path: "asset:P|old.png" },
        { file_path: "asset:Q|slow.png" },
      ]),
    ]);
    const ref = (file_path: string) => ({ file_path });
    expect(refJudged("", ref("asset:뻘뻘뻘_RnD|CH/m/a.png"))).toBe(false); // 아직 묻기 전 = '확인 중'
    locate.mockResolvedValue(
      answer({
        unresolved: ["asset:뻘뻘뻘_RnD|CH/m/a.png", "asset:imports|copy.png", "asset:P|old.png", "asset:Q|slow.png"],
        incomplete: ["asset:Q|slow.png"],
        held: {
          "asset:뻘뻘뻘_RnD|CH/m/a.png": { why: "multiple", count: 2, projects: ["RnD", "뻘뻘뻘"] },
          "asset:imports|copy.png": { why: "copy_name", count: 1, projects: ["뻘뻘뻘"] },
        },
      }),
    );
    await relinkSceneAssetRefs();
    expect(status("", "asset:뻘뻘뻘_RnD|CH/m/a.png")).toBe("held");
    expect(heldText(refHeldInfo("", ref("asset:뻘뻘뻘_RnD|CH/m/a.png"))!)).toMatchObject({
      title: "연결 안 됨 · 후보 2곳",
      detail: "RnD · 뻘뻘뻘 에 같은 파일",
      fix: "워크스페이스를 고르면 이어짐",
    });
    expect(heldText(refHeldInfo("", ref("asset:imports|copy.png"))!)).toMatchObject({ title: "사본 · 서버에 같은 이름", copy: true });
    // 옛 허브의 답(이유 없음)이면 '연결 안 됨'
    expect(heldText(refHeldInfo("", ref("asset:P|old.png"))!).title).toBe("연결 안 됨");
    expect(status("", "asset:Q|slow.png")).toBe("incomplete"); // 회색 — 빨강 아님
    expect(refJudged("", ref("asset:뻘뻘뻘_RnD|CH/m/a.png"))).toBe(true);
  });

  it("레퍼런스 찾기가 판정을 못 끝내면 옛 '서버에 없음'을 지운다 — NAS 가 끊긴 동안 빨강이 굳지 않게(Codex)", async () => {
    await saveScenes(null, [scene([{ file_path: "asset:Q|gone.png" }])]);
    locate.mockResolvedValueOnce(answer({ unresolved: ["asset:Q|gone.png"], missing: ["asset:Q|gone.png"] }));
    await relinkSceneAssetRefs();
    expect(status("", "asset:Q|gone.png")).toBe("missing");
    locate.mockResolvedValueOnce(answer({ unresolved: ["asset:Q|gone.png"], incomplete: ["asset:Q|gone.png"] }));
    await findSceneAssetRefs("s1", {});
    expect(status("", "asset:Q|gone.png")).toBe("incomplete");
    resetRelinkSessionForTest(); // 다시 켜면 다시 묻는다
    locate.mockResolvedValueOnce(answer({ unresolved: ["asset:Q|gone.png"], missing: ["asset:Q|gone.png"] }));
    await relinkSceneAssetRefs();
    expect(locate).toHaveBeenCalledTimes(3);
  });
});

describe("판정 못 끝냄은 대체 열쇠의 옛 판정까지 지운다(Codex P1 2026-09-30)", () => {
  beforeEach(async () => {
    localStorage.clear();
    resetRelinkSessionForTest();
    locate.mockReset();
  });

  it("지문 없이 '서버에 없음'으로 기억한 참조에 나중에 지문이 붙고, 찾기가 판정을 못 끝내면 회색이 된다", async () => {
    await saveScenes(null, [scene([{ file_path: "asset:Q|gone.png" }])]);
    locate.mockResolvedValueOnce(answer({ unresolved: ["asset:Q|gone.png"], missing: ["asset:Q|gone.png"] }));
    await relinkSceneAssetRefs();
    expect(status("", "asset:Q|gone.png")).toBe("missing");

    const fp = { content_sha: "a".repeat(64), bytes: 5 };
    await saveScenes(null, [scene([{ file_path: "asset:Q|gone.png", ...fp }])]); // 넣을 때 판이 붙었다
    expect(status("", "asset:Q|gone.png", fp)).toBe("missing"); // 표시는 지문 없는 옛 열쇠를 읽는다
    locate.mockResolvedValueOnce(answer({ unresolved: ["asset:Q|gone.png"], incomplete: ["asset:Q|gone.png"] }));
    await findSceneAssetRefs("s1", {});
    expect(status("", "asset:Q|gone.png", fp)).toBe("incomplete");
  });
});

describe("판정 못 끝냄은 같은 토큰을 쓰는 모든 참조의 옛 판정을 지운다(Codex P1 재검토)", () => {
  beforeEach(async () => {
    localStorage.clear();
    resetRelinkSessionForTest();
    locate.mockReset();
  });

  it("지문 A 로 '서버에 없음' → 같은 토큰에 지문 B 참조가 더해짐 → 찾기가 판정을 못 끝내면 A 도 회색", async () => {
    const a = { content_sha: "a".repeat(64), bytes: 5 };
    const b = { content_sha: "b".repeat(64), bytes: 6 };
    await saveScenes(null, [scene([{ file_path: "asset:imports|x.png", ...a }])]);
    locate.mockResolvedValueOnce(answer({ unresolved: ["asset:imports|x.png"], missing: ["asset:imports|x.png"] }));
    await relinkSceneAssetRefs();
    expect(status("", "asset:imports|x.png", a)).toBe("missing");

    await saveScenes(null, [scene([{ file_path: "asset:imports|x.png", ...a }, { file_path: "asset:imports|x.png", ...b }])]);
    locate.mockResolvedValueOnce(answer({ unresolved: ["asset:imports|x.png"], incomplete: ["asset:imports|x.png"] }));
    // 화면은 알림이 올 때 다시 그린다 — 그 순간 읽는 값이 맞아야 한다(끝의 가지치기는 알리지 않는다)
    const seenOnNotify: (string | undefined)[] = [];
    const off = subscribeRefServerStatus(() => seenOnNotify.push(status("", "asset:imports|x.png", a)));
    await findSceneAssetRefs("s1", {});
    off();
    expect(locate.mock.calls[1][3]).toEqual({}); // 지문이 서로 달라 지문 없이 물었다
    expect(seenOnNotify).toEqual(["incomplete"]);
    expect(status("", "asset:imports|x.png", b)).toBe("incomplete");
  });
});

describe("판정을 받았는데 그림이 안 뜨면 한 번 다시 묻는다(2026-09-30 실측)", () => {
  beforeEach(async () => {
    localStorage.clear();
    resetRelinkSessionForTest();
    locate.mockReset();
  });

  it("번호를 받은 뒤 NAS 에서 옮겨져 그림이 깨지면 '확인 중'으로 되돌려 한 번 묻고, 번호로 새 자리를 받는다", async () => {
    await saveScenes(null, [scene([{ file_path: "asset:P|CH/p.png" }])]);
    locate.mockResolvedValueOnce(answer({ open: ["asset:P|CH/p.png"], open_ids: { "asset:P|CH/p.png": "r1" } }));
    await relinkSceneAssetRefs();
    const ref = listScenes(null)[0].cards[0].refs![0];
    expect(ref.registry_asset_id).toBe("r1");

    resetRelinkSessionForTest(); // 앱을 다시 켰다 — 저장된 '열림'은 묻지 않는다
    await relinkSceneAssetRefs();
    expect(locate).toHaveBeenCalledTimes(1);

    // 그림이 안 뜬다 → 판정을 지우고(화면은 '확인 중') 다음 복구에서 번호를 실어 묻는다
    expect(recheckBrokenRef("", ref)).toBe(true);
    expect(refJudged("", ref)).toBe(false);
    locate.mockResolvedValueOnce(
      answer({
        fixed: [{ token: "asset:P|CH/p.png", project: "P", path: "CH/old/p_v2.png", registry_asset_id: "r1" }],
        unresolved: ["asset:P|CH/p.png"],
      }),
    );
    await relinkSceneAssetRefs();
    expect(locate).toHaveBeenCalledTimes(2);
    expect(locate.mock.calls[1][6]).toEqual({ "asset:P|CH/p.png": "r1" });
    expect(listScenes(null)[0].cards[0].refs?.[0]).toMatchObject({ file_path: "asset:P|CH/old/p_v2.png", registry_asset_id: "r1" });
  });

  it("세션마다 한 번만 — 파일이 깨져 늘 안 뜨는 참조가 되풀이해 묻지 않는다. 판정 전·사본 아닌 토큰은 건드리지 않는다", async () => {
    await saveScenes(null, [scene([{ file_path: "asset:P|a.png" }])]);
    expect(recheckBrokenRef("", { file_path: "asset:P|a.png" })).toBe(false); // 판정 전 — 자동 복구가 어차피 묻는다
    expect(recheckBrokenRef("", { file_path: "gen:abc" })).toBe(false);
    locate.mockResolvedValue(answer({ open: ["asset:P|a.png"] }));
    await relinkSceneAssetRefs();
    expect(recheckBrokenRef("", { file_path: "asset:P|a.png" })).toBe(true);
    await relinkSceneAssetRefs();
    expect(locate).toHaveBeenCalledTimes(2);
    expect(recheckBrokenRef("", { file_path: "asset:P|a.png" })).toBe(false); // 다시 '열림'인데 또 깨짐 — 더 묻지 않는다
  });
});

describe("선택 공간을 바꾸면 세션 안에서도 새 공간으로 한 번 묻는다(2026-10-01 점검 R2-2)", () => {
  beforeEach(async () => {
    localStorage.clear();
    resetRelinkSessionForTest();
    locate.mockReset();
  });

  const pick = (id: string) =>
    localStorage.setItem(STORAGE_KEYS.workspaceContext, JSON.stringify({ scope: "team", id, name: id }));
  const A = "asset:P|CH/a.png";
  const B = "asset:P|CH/b.png";
  const asked = () => locate.mock.calls.map((c) => c[1]);
  const nextTick = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("보류만 새 공간으로 한 번 묻고 열림은 안 묻는다 — 같은 공간이면 다시 안 묻는다", async () => {
    pick("W0");
    await saveScenes(null, [scene([{ file_path: A }, { file_path: B }])]);
    locate.mockResolvedValueOnce(answer({ unresolved: [A, B], open: [B] }));
    await relinkSceneAssetRefs();
    await relinkSceneAssetRefs();
    expect(asked()).toEqual(["W0"]);

    pick("W1"); // 앱을 다시 켜지 않고 위에서 공간만 바꿨다
    locate.mockResolvedValue(answer({ unresolved: [A] }));
    await relinkSceneAssetRefs();
    expect(locate.mock.calls[1][0]).toEqual([A]);
    await relinkSceneAssetRefs();
    expect(asked()).toEqual(["W0", "W1"]);
  });

  it("옛 공간의 답이 늦게 와도 새 공간 질문을 막지 않는다", async () => {
    pick("W0");
    await saveScenes(null, [scene([{ file_path: A }])]);
    let finishW0!: (reply: unknown) => void;
    locate.mockImplementationOnce(() => new Promise((resolve) => { finishW0 = resolve; }));
    locate.mockResolvedValue(answer({ unresolved: [A] }));
    const first = relinkSceneAssetRefs();
    await nextTick();
    pick("W1");
    const second = relinkSceneAssetRefs(); // 도는 중 — 끝난 뒤 한 번 더
    finishW0(answer({ unresolved: [A] }));
    await first;
    await second;
    expect(asked()).toEqual(["W0", "W1"]);
    await relinkSceneAssetRefs();
    expect(asked()).toEqual(["W0", "W1"]);
  });

  it("옛 공간 질문이 실패해도 그 사이 바꾼 새 공간으로는 묻는다(Codex 코드 리뷰)", async () => {
    pick("W0");
    await saveScenes(null, [scene([{ file_path: A }])]);
    let failW0!: (error: Error) => void;
    locate.mockImplementationOnce(() => new Promise((_resolve, reject) => { failW0 = reject; }));
    locate.mockResolvedValue(answer({ unresolved: [A] }));
    const first = relinkSceneAssetRefs();
    await nextTick();
    pick("W1");
    const second = relinkSceneAssetRefs();
    failW0(new Error("hub down"));
    await first;
    await second;
    expect(asked()).toEqual(["W0", "W1"]);
  });

  it("공간을 빨리 오가도 (공간, 토큰)마다 한 번까지 — 판정 못 끝냄도 같은 공간에선 다시 안 묻는다", async () => {
    pick("W0");
    await saveScenes(null, [scene([{ file_path: A }])]);
    locate.mockResolvedValueOnce(answer({ incomplete: [A] }));
    locate.mockResolvedValue(answer({ unresolved: [A] }));
    await relinkSceneAssetRefs();
    await relinkSceneAssetRefs();
    expect(asked()).toEqual(["W0"]);
    pick("W1");
    await relinkSceneAssetRefs();
    pick("W0");
    await relinkSceneAssetRefs();
    pick("W1");
    await relinkSceneAssetRefs();
    expect(asked()).toEqual(["W0", "W1"]);
  });
});
