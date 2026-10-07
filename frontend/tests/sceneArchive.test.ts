// 캔버스 전체 내보내기·가져오기, 그리고 옛 판 창과 엇갈린 씬을 새 탭으로 살리기(2026-10-07).
//
// 둘 다 "잃지 않는다"가 계약이다: 가져오기는 지금 것을 덮지 않고, 엇갈린 씬은 양쪽을 다 남긴다.
// 그리고 둘 다 되풀이해도 탭이 끝없이 늘지 않아야 한다(같은 파일을 두 번·옛 창이 계속 고침).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setAccountScope } from "../src/lib/accountScope";
import {
  SCENE_ARCHIVE_FORMAT,
  exportSceneArchiveText,
  importSceneArchiveText,
  parseSceneArchive,
} from "../src/lib/sceneArchive";
import {
  absorbLegacyScenes,
  failSceneStoreWritesForTest,
  initSceneStore,
  readScenesCache,
  resetSceneStoreForTest,
  sceneStoreConflicts,
  settleSceneStoreForTest,
  type LegacyMark,
} from "../src/lib/sceneStore";
import {
  createScene,
  exportSceneText,
  hasSceneConflicts,
  listPersistedScenes,
  listScenes,
  recoverSceneConflicts,
  saveScenes,
  updateScene,
  type Scene,
  type ScenesByProject,
} from "../src/lib/scenes";
import { saveString } from "../src/lib/storage";
import { STORAGE_KEYS } from "../src/lib/storageKeys";

function storageMock(): Storage {
  const store: Record<string, string> = {};
  return {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => {
      store[k] = String(v);
    },
    removeItem: (k: string) => {
      delete store[k];
    },
    clear: () => {
      for (const k of Object.keys(store)) delete store[k];
    },
    key: (i: number) => Object.keys(store)[i] ?? null,
    get length() {
      return Object.keys(store).length;
    },
  } as Storage;
}
const mk = (id: string, name = id): Scene => ({ id, name, cards: [], edges: [], created_at: 1 });
const names = (list: Scene[]) => list.map((s) => s.name);
const ACCOUNT = "a@x.com";
const bucketOf = (account: string) => `acct:${account}::_none`; // scenes.ts 의 버킷 키(계정 네임스페이스)
const BUCKET = bucketOf(ACCOUNT);

beforeEach(() => {
  (globalThis as { localStorage?: Storage }).localStorage = storageMock();
  (globalThis as { sessionStorage?: Storage }).sessionStorage = storageMock();
  saveString(STORAGE_KEYS.activeAccount, ACCOUNT);
  setAccountScope(ACCOUNT);
});
afterEach(() => {
  failSceneStoreWritesForTest(false);
  delete (globalThis as { sessionStorage?: Storage }).sessionStorage;
});

describe("캔버스 전체 내보내기·가져오기", () => {
  it("내보낸 파일을 빈 저장소에 가져오면 계정·씬 id 그대로 돌아온다", async () => {
    saveScenes(null, [mk("s1"), mk("s2")]);
    await settleSceneStoreForTest();
    const text = await exportSceneArchiveText();
    expect(Object.keys(parseSceneArchive(text).buckets)).toEqual([BUCKET]);

    resetSceneStoreForTest(); // 다른 PC·지워진 브라우저
    expect(listScenes(null)).toEqual([]);
    expect(await importSceneArchiveText(text)).toEqual({ added: 2, recovered: 0 });
    expect(listScenes(null).map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(listPersistedScenes(null).map((s) => s.id)).toEqual(["s1", "s2"]); // 화면만이 아니라 저장소에
  });

  // 내보내기는 저장소가 막혔을 때 작업을 건지는 길이다 — 확정본만 실으면 정작 건져야 할 편집이 빠진다.
  it("아직 저장소에 확정되지 않은 편집도 파일에 들어간다", async () => {
    saveScenes(null, [mk("s1")]);
    await settleSceneStoreForTest();
    failSceneStoreWritesForTest(true);
    updateScene(null, "s1", { name: "막힌 동안 고친 이름" });
    createScene(null, "막힌 동안 만든 씬");
    expect(await settleSceneStoreForTest()).toBe(false);
    expect(names(listPersistedScenes(null))).toEqual(["s1"]); // 확정본에는 없다

    const { buckets } = parseSceneArchive(await exportSceneArchiveText());
    expect(names(buckets[BUCKET])).toEqual(["막힌 동안 고친 이름", "막힌 동안 만든 씬"]);
  });

  it("가져오기는 덮지 않는다 — 없는 씬만 더하고, 같은 씬인데 내용이 다르면 사본으로 따로 둔다", async () => {
    saveScenes(null, [mk("same"), mk("diff", "파일 쪽 이름"), mk("onlyFile")]);
    await settleSceneStoreForTest();
    const text = await exportSceneArchiveText();

    resetSceneStoreForTest();
    saveScenes(null, [mk("same"), mk("diff", "지금 이름"), mk("onlyLocal")]);
    await settleSceneStoreForTest();
    expect(await importSceneArchiveText(text)).toEqual({ added: 1, recovered: 1 });
    const now = listScenes(null);
    expect(names(now)).toEqual(["same", "지금 이름", "onlyLocal", "[사본] 파일 쪽 이름", "onlyFile"]);
    expect(now.find((s) => s.name === "지금 이름")?.id).toBe("diff"); // 지금 것은 그대로
    expect(now[3].id).not.toBe("diff"); // 사본은 새 id

    // 같은 파일을 또 가져와도 사본이 또 생기지 않는다 — 사본의 이름을 바꾸거나 고친 뒤에도.
    updateScene(null, now[3].id, { name: "내가 정리한 이름", camera: { x: 1, y: 2, z: 3 } });
    expect(await importSceneArchiveText(text)).toEqual({ added: 0, recovered: 0 });
    expect(listScenes(null)).toHaveLength(5);
  });

  it("다른 계정의 캔버스도 그 계정 자리에 그대로 들어간다(지금 계정에 섞이지 않는다)", async () => {
    await initSceneStore(() => null, null, () => true); // 빈 브라우저에서 앱을 켠 상태
    const text = JSON.stringify({
      format: SCENE_ARCHIVE_FORMAT,
      schemaVersion: 1,
      buckets: { [BUCKET]: [mk("mine")], [bucketOf("b@x.com")]: [mk("theirs")], [bucketOf("c@x.com")]: [] },
    });
    expect(await importSceneArchiveText(text)).toEqual({ added: 2, recovered: 0 });
    expect(listScenes(null).map((s) => s.id)).toEqual(["mine"]);
    const all = readScenesCache();
    expect(all[bucketOf("b@x.com")].map((s) => s.id)).toEqual(["theirs"]);
    expect(all[bucketOf("c@x.com")]).toEqual([]); // 빈 버킷도 그대로(= '다 지웠다'는 뜻이 보존된다)
  });

  it("이상한 파일은 통째로 거절한다 — 반쯤 들어가는 일이 없다", async () => {
    saveScenes(null, [mk("s1")]);
    await settleSceneStoreForTest();
    const archive = (extra: object) => JSON.stringify({ format: SCENE_ARCHIVE_FORMAT, schemaVersion: 1, ...extra });
    const bad: [string, RegExp][] = [
      ["{{", /JSON/],
      [exportSceneText(mk("one")), /씬 하나짜리/], // 씬 하나짜리 파일 — 어디로 가야 하는지 알려 준다
      [JSON.stringify({ format: SCENE_ARCHIVE_FORMAT, schemaVersion: 99, buckets: {} }), /업데이트/],
      [archive({}), /손상/],
      [archive({ buckets: { [BUCKET]: [mk("ok"), { id: "broken" }] } }), /손상/],
      [archive({ buckets: { [BUCKET]: { not: "a list" } } }), /손상/],
      [archive({ buckets: { [BUCKET]: [{ ...mk("nullcard"), cards: [null] }] } }), /손상/],
      [archive({ buckets: { [BUCKET]: [{ ...mk("badkind"), cards: [{ id: "c", kind: "???", x: 0, y: 0 }] }] } }), /손상/],
      // 충돌 기록의 씬도 나중에 탭으로 되살아나 화면에 닿는다 — 같은 검증을 지난다.
      [archive({ buckets: {}, conflicts: [{ bucket: BUCKET, sceneId: "x", mine: null, theirs: { id: "x" } }] }), /손상/],
      [archive({ buckets: {}, conflicts: ["??"] }), /손상/],
    ];
    for (const [text, why] of bad) await expect(importSceneArchiveText(text)).rejects.toThrow(why);
    expect(listScenes(null).map((s) => s.id)).toEqual(["s1"]); // 멀쩡한 'ok' 도 들어가지 않았다
    expect(sceneStoreConflicts()).toEqual([]);
  });

  // 이름 없는 씬·숫자가 아닌 좌표가 저장소에 들어가면 탭 줄·캔버스가 그리다 죽고, 저장돼 있으니 다시 켜도
  // 죽는다(Codex 코드 리뷰 P1). 고칠 수 있는 것은 씬 파일 가져오기와 같은 기준으로 고쳐서 넣는다.
  it("고칠 수 있는 흠은 화면이 믿는 모양으로 고쳐서 넣는다", async () => {
    await initSceneStore(() => null, null, () => true); // 빈 브라우저에서 앱을 켠 상태
    const text = JSON.stringify({
      format: SCENE_ARCHIVE_FORMAT,
      schemaVersion: 1,
      buckets: {
        [BUCKET]: [
          {
            id: "odd",
            cards: [
              { id: "c1", kind: "text", x: "왼쪽", y: null, refs: "없음" },
              // 필드 안쪽까지 — 화면은 `card.text.trim()`·`refs.map(r => r.file_path)` 처럼 타입을 믿고 쓴다.
              {
                id: "c2",
                kind: "generation",
                x: 1,
                y: 2,
                text: {},
                prompt: 7,
                status: "모름",
                genId: 3,
                genIds: ["g1", null, 5],
                refs: [null, "글자", { file_path: "asset:P|a.png", type: "image", thumb: 5, origin: "?" }, { type: "image" }],
                pendingGenerationAttempts: [{ attemptId: "a", generationId: "g", createdAt: 1 }, { attemptId: "b" }],
                modelCfg: { model: "m", params: { ok: 1, bad: { nested: true } } },
              },
              {
                id: "c3",
                kind: "comfy",
                x: 0,
                y: 0,
                comfyCfg: {
                  name: 1,
                  status: "done",
                  paramExposed: ["a|b", 3],
                  paramValues: { "a|b": 2, "x|y": [1] },
                  params: [{ key: "a|b", label: "값", type: "number", choices: [1, "둘", {}] }, { key: "k" }],
                  output: { url: 9 },
                  outputs: [{ kind: "text", text: "ok", url: 1 }, { kind: "???" }, null],
                },
              },
            ],
            edges: [{ id: "e1", from: "c1", to: "c1", role: "ref", order: "첫째" }, null, { id: "e2" }],
            groups: [{ id: "g1", cardIds: ["c1", "gone", 7], rect: { x: 0, y: 0, w: "넓게", h: 1 }, collapsed: true }, { id: "g2" }],
            camera: { x: "0", y: 0, z: 1 },
            recoveredFrom: "문자열",
            surprise: "모르는 필드",
          },
        ],
      },
    });
    expect(await importSceneArchiveText(text)).toEqual({ added: 1, recovered: 0 });
    expect(listScenes(null)).toEqual([
      {
        id: "odd",
        name: "이름 없는 씬",
        cards: [
          { id: "c1", kind: "text", x: 0, y: 0 },
          {
            id: "c2",
            kind: "generation",
            x: 1,
            y: 2,
            genIds: ["g1"],
            refs: [{ file_path: "asset:P|a.png", type: "image" }],
            pendingGenerationAttempts: [{ attemptId: "a", generationId: "g", createdAt: 1 }],
            modelCfg: { model: "m", params: { ok: 1 } },
          },
          {
            id: "c3",
            kind: "comfy",
            x: 0,
            y: 0,
            comfyCfg: {
              status: "done",
              paramExposed: ["a|b"],
              paramValues: { "a|b": 2 },
              params: [{ key: "a|b", label: "값", type: "number", choices: [1, "둘"] }],
              outputs: [{ kind: "text", text: "ok" }],
            },
          },
        ],
        edges: [{ id: "e1", from: "c1", to: "c1", role: "ref" }],
        groups: [{ id: "g1", name: "", cardIds: ["c1"], collapsed: true }],
        created_at: 0,
      },
    ]);
  });

  // 정규화가 지금 저장소의 씬과 모양을 조금 다르게 만들 수 있다(빈 그룹 목록 등) — 그것을 '내용이 다르다'로
  // 읽으면 자기가 내보낸 파일을 다시 가져올 때마다 사본 탭이 생긴다.
  it("정규화로만 달라지는 씬은 같은 씬으로 본다", async () => {
    saveScenes(null, [{ ...mk("s1"), groups: [] }]);
    await settleSceneStoreForTest();
    const text = await exportSceneArchiveText();
    expect(await importSceneArchiveText(text)).toEqual({ added: 0, recovered: 0 });
    expect(listScenes(null)).toHaveLength(1);
  });
});

describe("옛 판 창과 엇갈린 씬을 새 탭으로 살린다", () => {
  const MARK = "[옛 창] ";
  // 옛 판 창이 옛 저장소(localStorage)에 쓴 내용.
  const legacy = (...scenes: Scene[]): ScenesByProject => ({ [BUCKET]: scenes });

  // 이관을 마친 상태에서 시작한다(기준 B = 그때의 옛 저장소).
  async function boot(...scenes: Scene[]) {
    let mark: LegacyMark | null = null;
    const result = await initSceneStore(
      () => legacy(...scenes),
      mark,
      (next) => {
        mark = next;
        return true;
      },
    );
    expect(result.kind).toBe("ready");
  }

  it("양쪽이 각자 고친 씬은 내 것을 두고, 옛 창 쪽을 새 탭으로 더한다", async () => {
    await boot(mk("s1", "원래"), mk("s2"));
    updateScene(null, "s1", { name: "이 창에서 고침" });
    await settleSceneStoreForTest();
    await absorbLegacyScenes(legacy(mk("s1", "옛 창에서 고침"), mk("s2")));
    expect(hasSceneConflicts()).toBe(true);
    expect(names(listScenes(null))).toEqual(["이 창에서 고침", "s2"]); // 자동으로 덮지 않았다

    expect(await recoverSceneConflicts()).toEqual({ copied: 1, refreshed: 0, keptMine: 0 });
    expect(names(listScenes(null))).toEqual(["이 창에서 고침", "s2", `${MARK}옛 창에서 고침`]);
    expect(names(listPersistedScenes(null))).toEqual(names(listScenes(null)));
    expect(hasSceneConflicts()).toBe(false);
    expect(sceneStoreConflicts()).toEqual([]);
    expect(await recoverSceneConflicts()).toEqual({ copied: 0, refreshed: 0, keptMine: 0 }); // 또 불러도 그대로
    expect(listScenes(null)).toHaveLength(3);
  });

  it("옛 창이 지웠는데 이 창에서 고친 씬은 그대로 둔다", async () => {
    await boot(mk("s1", "원래"));
    updateScene(null, "s1", { name: "이 창에서 고침" });
    await settleSceneStoreForTest();
    await absorbLegacyScenes(legacy());
    expect(await recoverSceneConflicts()).toEqual({ copied: 0, refreshed: 0, keptMine: 1 });
    expect(names(listScenes(null))).toEqual(["이 창에서 고침"]);
  });

  // 옛 창이 그 씬을 계속 고치면 저장할 때마다 또 엇갈린다 — 그때마다 탭을 더하면 탭도 저장소도 끝없이 는다.
  it("옛 창이 같은 씬을 계속 고쳐도 사본 탭은 하나다 — 손대지 않은 사본을 최신으로 갈아 끼운다", async () => {
    await boot(mk("s1", "원래"));
    updateScene(null, "s1", { name: "이 창에서 고침" });
    await settleSceneStoreForTest();

    await absorbLegacyScenes(legacy(mk("s1", "옛 창 1")));
    await recoverSceneConflicts();
    const first = listScenes(null)[1];
    updateScene(null, first.id, { name: "사본 탭 이름만 바꿈" }); // 이름만 바꾼 것은 '손댄 것'이 아니다
    await settleSceneStoreForTest();

    await absorbLegacyScenes(legacy({ ...mk("s1", "옛 창 2"), camera: { x: 9, y: 9, z: 1 } }));
    expect(await recoverSceneConflicts()).toEqual({ copied: 0, refreshed: 1, keptMine: 0 });
    const now = listScenes(null);
    expect(now).toHaveLength(2);
    expect(now[1].id).toBe(first.id); // 같은 탭
    expect(now[1].name).toBe("사본 탭 이름만 바꿈");
    expect(now[1].camera).toEqual({ x: 9, y: 9, z: 1 }); // 내용은 옛 창의 최신
  });

  it("사본 탭을 고쳐 쓰고 있었으면 건드리지 않고 새 탭을 더한다", async () => {
    await boot(mk("s1", "원래"));
    updateScene(null, "s1", { name: "이 창에서 고침" });
    await settleSceneStoreForTest();
    await absorbLegacyScenes(legacy(mk("s1", "옛 창 1")));
    await recoverSceneConflicts();
    const first = listScenes(null)[1];
    updateScene(null, first.id, { camera: { x: 5, y: 5, z: 2 } }); // 사본에서 작업을 이어 갔다
    await settleSceneStoreForTest();

    await absorbLegacyScenes(legacy(mk("s1", "옛 창 2")));
    expect(await recoverSceneConflicts()).toEqual({ copied: 1, refreshed: 0, keptMine: 0 });
    const now = listScenes(null);
    expect(names(now)).toEqual(["이 창에서 고침", `${MARK}옛 창 1`, `${MARK}옛 창 2`]);
    expect(now[1].camera).toEqual({ x: 5, y: 5, z: 2 }); // 고친 사본은 그대로
  });

  it("다른 계정의 엇갈림은 그 계정이 정리한다 — 지금 계정이 건드리지 않는다", async () => {
    let mark: LegacyMark | null = null;
    const other = bucketOf("b@x.com");
    await initSceneStore(
      () => ({ [other]: [mk("o1", "원래")] }),
      mark,
      (next) => {
        mark = next;
        return true;
      },
    );
    setAccountScope("b@x.com");
    updateScene(null, "o1", { name: "b 가 이 창에서 고침" });
    await settleSceneStoreForTest();
    await absorbLegacyScenes({ [other]: [mk("o1", "b 의 옛 창에서 고침")] });

    setAccountScope(ACCOUNT);
    expect(hasSceneConflicts()).toBe(false);
    expect(await recoverSceneConflicts()).toEqual({ copied: 0, refreshed: 0, keptMine: 0 });
    expect(sceneStoreConflicts()).toHaveLength(1); // 남아 있다
    setAccountScope("b@x.com");
    expect(hasSceneConflicts()).toBe(true);
  });
});
