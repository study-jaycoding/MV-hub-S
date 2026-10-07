// 씬 쓰기 계약 — 씬 편집 1회에 저장소를 여러 번 파싱하지 않게 한 변경의 회귀 방지.
//  (호출부 patchSceneById 는 updateScene 의 반환값을 그대로 화면 상태로 쓴다 → listScenes 재조회 없음.)
//  ★쓰기는 두 박자다(2026-10-07 IndexedDB 전환): 화면 값에는 **그 자리에서** 반영되고, 저장소 확정은
//   뒤따른다. 그래서 반환값은 '화면 값에 반영됐나'이고, 확정 실패는 반환이 아니라 알림
//   (subscribeSceneSaveState)과 작업별 확정 결과(confirmSceneWrite)로 알린다.
//  ★반환 실패는 두 가지다 — storage(저장소를 쓸 수 없음) / missing(대상 씬이 없어 바뀐 게 없음).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  confirmSceneWrite,
  createScene,
  deleteScene,
  hasSceneBucket,
  listPersistedScenes,
  listScenes,
  mergeScenesFromBackup,
  saveScenes,
  subscribeSceneSaveState,
  subscribeScenesPersisted,
  updateScene,
  type Scene,
  type SceneWriteResult,
} from "../src/lib/scenes";
import {
  failSceneStoreWritesForTest,
  readScenesCache,
  settleSceneStoreForTest,
  writeScenesStore,
} from "../src/lib/sceneStore";
import { saveString } from "../src/lib/storage";
import { STORAGE_KEYS } from "../src/lib/storageKeys";
import { setAccountScope } from "../src/lib/accountScope";

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
function installStorageMocks() {
  (globalThis as { localStorage?: Storage }).localStorage = storageMock();
  (globalThis as { sessionStorage?: Storage }).sessionStorage = storageMock();
}
const mkScene = (id: string): Scene => ({ id, name: id, cards: [], edges: [], created_at: 1 });
const names = (scenes: Scene[]) => scenes.map((s) => s.name);

// 화면 값 반영을 단언하고 목록을 꺼낸다(성공 경로 테스트용).
function applied(result: SceneWriteResult): Scene[] {
  expect(result.ok).toBe(true);
  return result.ok ? result.scenes : [];
}

// 저장소 확정이 실패하는 상황(용량 초과·접근 차단) 재현. run 안의 쓰기는 화면 값에만 남고,
// 확정 시도가 실패로 끝난 뒤에 돌아온다(그 뒤로는 저장소가 다시 받는다).
async function whileStoreFails<T>(run: () => T): Promise<T> {
  failSceneStoreWritesForTest(true);
  try {
    const out = run();
    expect(await settleSceneStoreForTest()).toBe(false);
    return out;
  } finally {
    failSceneStoreWritesForTest(false);
  }
}

describe("씬 쓰기 계약", () => {
  beforeEach(() => {
    installStorageMocks();
    saveString(STORAGE_KEYS.activeAccount, "a@x.com");
    setAccountScope("a@x.com");
  });
  afterEach(async () => {
    // '저장 실패 중' 상태는 scenes 모듈에 남는다 — 밀린 연산을 확정시켜 다음 시험을 조용한 상태에서 연다.
    failSceneStoreWritesForTest(false);
    await settleSceneStoreForTest();
    delete (globalThis as { sessionStorage?: Storage }).sessionStorage;
  });

  it("갱신된 목록을 반환하고, 그 내용이 화면 값·확정본과 같다", async () => {
    saveScenes(null, [mkScene("s1"), mkScene("s2")]);
    const next = applied(updateScene(null, "s1", { name: "바뀐 이름" }));

    expect(next.map((s) => s.id)).toEqual(["s1", "s2"]); // 순서 보존
    expect(next.find((s) => s.id === "s1")?.name).toBe("바뀐 이름");
    expect(next.find((s) => s.id === "s2")?.name).toBe("s2"); // 다른 씬은 그대로
    expect(next).toEqual(listScenes(null)); // 반환값 = 화면 값(호출부가 다시 읽을 필요 없음)
    expect(await settleSceneStoreForTest()).toBe(true);
    expect(listPersistedScenes(null)).toEqual(next); // 확정되면 저장소도 같다
  });

  // 캔버스는 자기가 넘긴 cards 배열을 그대로 되받아야 '바뀐 게 없다'로 보고 다시 그리지 않는다.
  it("반환 목록의 고친 씬은 넘긴 patch 의 참조를 그대로 든다", () => {
    saveScenes(null, [mkScene("s1")]);
    const cards: Scene["cards"] = [];
    const next = applied(updateScene(null, "s1", { cards }));
    expect(next[0].cards).toBe(cards);
  });

  // 저장소에 쓰는 것과 '요청한 대상을 바꾸는 것'은 다른 성공이다. 종전에는 없는 씬에 쓴 편집도
  // 성공으로 보고해, 호출부가 그 편집을 저장된 것처럼 화면에 남겼다(적대 리뷰 r3).
  it("없는 씬 id 면 missing — 씬을 만들지도, 성공으로 보고하지도 않는다", () => {
    saveScenes(null, [mkScene("s1")]);
    const result = updateScene(null, "gone", { name: "x" });
    expect(result).toEqual({ ok: false, reason: "missing" });
    expect(listScenes(null).map((s) => s.id)).toEqual(["s1"]);
  });

  // 계정 네임스페이스 도입 전의 옛 키(`_none`)는 localStorage→IndexedDB 이관 때 그대로 따라온다.
  // 그 뒤 현재 계정 버킷으로 1회 옮겨져야 한다 — 안 옮기면 다른 계정이 나중에 가져가 버린다.
  it("네임스페이스 도입 전 옛 버킷도 그대로 이관해 갱신한다", async () => {
    await writeScenesStore({ _none: [mkScene("old")] });
    const next = applied(updateScene(null, "old", { name: "이관됨" }));
    expect(names(next)).toEqual(["이관됨"]);
    expect(names(listScenes(null))).toEqual(["이관됨"]);
    expect("_none" in next).toBe(false); // 반환 목록은 계정 버킷의 것
    expect(readScenesCache()._none).toBeUndefined(); // 옛 키는 저장소에서도 제거
  });

  // 확정이 실패했다고 화면을 되돌리지 않는다 — 되돌리면 사용자는 방금 한 편집이 사라지는 것만 본다
  // (2026-10-07 신고가 그 모양이었다). 편집은 화면에 남고, 저장소가 다시 받으면 그대로 확정된다.
  it("확정이 실패해도 편집은 화면에 남고, 저장소가 다시 받으면 확정된다", async () => {
    saveScenes(null, [mkScene("s1")]);
    await settleSceneStoreForTest();

    const { value, confirmed } = await whileStoreFails(() =>
      confirmSceneWrite(() => updateScene(null, "s1", { name: "아직 확정 안 됨" })),
    );
    expect(value.ok).toBe(true); // 화면 값에는 반영됐다
    expect(await confirmed).toBe(false); // 이 작업의 확정은 실패로 알린다
    expect(names(listScenes(null))).toEqual(["아직 확정 안 됨"]);
    expect(names(listPersistedScenes(null))).toEqual(["s1"]); // 확정본은 그대로

    expect(await settleSceneStoreForTest()).toBe(true); // 다시 시도 — 잃지 않는다
    expect(names(listPersistedScenes(null))).toEqual(["아직 확정 안 됨"]);
  });

  // 2026-10-07 신고의 뿌리: 저장이 실패해도 아무도 알려주지 않아, 사라지는 편집이 '연결 안 되는 버그'로
  // 읽혔다. 알림은 쓰기 관문 하나가 **상태가 바뀔 때만** 내보낸다 — 경로를 빠뜨릴 수 없고, 연속 실패에
  // 매번 띄워 폭주하지도 않는다.
  it("저장 실패·복귀를 상태가 바뀔 때만 알린다", async () => {
    saveScenes(null, [mkScene("s1")]);
    await settleSceneStoreForTest();
    const seen: boolean[] = [];
    const unsubscribe = subscribeSceneSaveState((failed) => seen.push(failed));
    try {
      updateScene(null, "s1", { name: "성공1" });
      await settleSceneStoreForTest();
      expect(seen).toEqual([]); // 잘 되는 동안은 조용하다

      await whileStoreFails(() => updateScene(null, "s1", { name: "실패1" }));
      await whileStoreFails(() => updateScene(null, "s1", { name: "실패2" }));
      expect(seen).toEqual([true]); // 연속 실패에도 한 번만

      updateScene(null, "s1", { name: "성공2" });
      await settleSceneStoreForTest();
      updateScene(null, "s1", { name: "성공3" });
      await settleSceneStoreForTest();
      expect(seen).toEqual([true, false]); // 복귀도 한 번만
    } finally {
      unsubscribe();
    }
  });

  // 부팅 첫 저장(옛 버킷 이관)이 실패하면 화면이 구독하기 전이다. 그때 '상태가 안 바뀌었다'는 이유로
  // 건너뛰면 그 세션 내내 조용하다 — 사용자는 계속 실패하는 편집만 본다(적대 리뷰 P1).
  it("이미 실패 중이면 늦게 구독한 화면에도 바로 알린다", async () => {
    saveScenes(null, [mkScene("s1")]);
    await settleSceneStoreForTest();
    await whileStoreFails(() => updateScene(null, "s1", { name: "실패" })); // 구독 전에 실패해 둔다
    const seen: boolean[] = [];
    const unsubscribe = subscribeSceneSaveState((failed) => seen.push(failed));
    try {
      expect(seen).toEqual([true]);
    } finally {
      unsubscribe();
    }
  });

  // 쓰기를 무조건 하면 없던 계정 버킷이 '빈 배열'로 생긴다. DB 자동복구는 '버킷 키가 아예 없을 때'만
  // 도므로, 그 한 번의 쓰기가 복구 경로를 영구히 막는다(코덱스 코드 리뷰).
  it("대상도 없고 이관할 것도 없으면 빈 버킷을 만들지 않는다", () => {
    expect(hasSceneBucket(null)).toBe(false);
    expect(updateScene(null, "gone", { name: "x" })).toEqual({ ok: false, reason: "missing" });
    expect(hasSceneBucket(null)).toBe(false); // 복구 판정이 그대로 열려 있어야 한다
  });

  // 같은 내용을 읽은 두 변경이 각각 저장소 전체를 덮으면 앞선 변경이 사라진다(이름을 바꾸고 바로
  // 카메라를 움직이면 이름이 되돌아감 — Codex 코드 리뷰에서 재현). 변경은 '결과'가 아니라 '연산'으로
  // 쌓여, 확정할 때 저장소의 최신 내용 위에서 차례로 다시 실행된다.
  it("같은 틱에 들어온 두 변경이 서로를 지우지 않는다", async () => {
    saveScenes(null, [mkScene("s1")]);
    const a = updateScene(null, "s1", { name: "이름 바꿈" });
    const b = updateScene(null, "s1", { camera: { x: 1, y: 2, z: 3 } });
    expect(a.ok && b.ok).toBe(true);
    expect(await settleSceneStoreForTest()).toBe(true);
    const saved = listPersistedScenes(null)[0];
    expect(saved.name).toBe("이름 바꿈"); // 먼저 들어온 변경이 살아 있다
    expect(saved.camera).toEqual({ x: 1, y: 2, z: 3 });
  });

  it("여러 씬을 잇달아 더해도 하나도 빠지지 않는다", async () => {
    saveScenes(null, []);
    createScene(null, "가");
    createScene(null, "나");
    createScene(null, "다");
    expect(names(listScenes(null))).toEqual(["가", "나", "다"]);
    expect(await settleSceneStoreForTest()).toBe(true);
    expect(names(listPersistedScenes(null))).toEqual(["가", "나", "다"]);
  });

  // 돌려준 씬은 반드시 화면 목록에 있어야 한다 — 종전에는 저장 못 한 씬을 돌려줘, 호출부가 목록에 없는
  // 씬을 활성 탭으로 잡아 빈 화면에 갇혔다. 확정이 늦어도(실패해도) 그 씬은 목록에 있고 다시 시도된다.
  it("createScene 이 돌려준 씬은 확정 전에도 화면 목록에 있다", async () => {
    const scene = await whileStoreFails(() => createScene(null, "새 씬"));
    expect(scene?.name).toBe("새 씬");
    expect(listScenes(null).map((s) => s.id)).toEqual([scene!.id]);
    expect(listPersistedScenes(null)).toEqual([]); // 아직 확정 전

    expect(await settleSceneStoreForTest()).toBe(true);
    expect(listPersistedScenes(null).map((s) => s.id)).toEqual([scene!.id]);
  });

  // 저장소가 든 객체를 내주면, 받은 쪽이 고친 것이 연산을 거치지 않고 저장소 값을 바꾼다(저장에서도 빠진다 —
  // 저장은 '객체가 같으면 안 바뀐 것'으로 본다). 쓰기 함수가 돌려주는 씬도 사본이어야 한다(Codex 코드 리뷰 P2).
  it("createScene·mergeScenesFromBackup 이 돌려준 씬은 사본이다 — 고쳐도 저장소 값이 안 바뀐다", () => {
    const made = createScene(null, "새 씬")!;
    made.name = "밖에서 고침";
    made.cards.push({ id: "c", kind: "text", x: 0, y: 0 });
    const { added } = mergeScenesFromBackup(null, [mkScene("from-db")]);
    expect(added.map((s) => s.id)).toEqual(["from-db"]);
    added[0].name = "밖에서 고침";
    expect(listScenes(null).map((s) => [s.name, s.cards.length])).toEqual([
      ["새 씬", 0],
      ["from-db", 0],
    ]);
  });

  // 삭제도 화면에서는 그 자리에서 사라지고, 확정본(=DB 미러가 올리는 내용)에는 확정된 뒤에만 빠진다 —
  // 저장되지도 않은 삭제가 서버 백업을 먼저 지우지 않는다.
  it("deleteScene 은 화면에서 바로 지우고, 확정본에서는 확정된 뒤에 빠진다", async () => {
    saveScenes(null, [mkScene("s1")]);
    await settleSceneStoreForTest();
    expect(await whileStoreFails(() => deleteScene(null, "s1"))).toBe(true);
    expect(listScenes(null)).toEqual([]);
    expect(listPersistedScenes(null).map((s) => s.id)).toEqual(["s1"]);

    expect(await settleSceneStoreForTest()).toBe(true);
    expect(listPersistedScenes(null)).toEqual([]);
  });

  it("확정이 실패하면 영속 구독자(DB 미러)를 부르지 않는다", async () => {
    saveScenes(null, [mkScene("s1")]);
    await settleSceneStoreForTest();
    let calls = 0;
    const unsubscribe = subscribeScenesPersisted(() => {
      calls += 1;
    });
    try {
      await whileStoreFails(() => updateScene(null, "s1", { name: "실패" }));
      expect(calls).toBe(0);
      expect(await settleSceneStoreForTest()).toBe(true);
      expect(calls).toBe(1); // 확정됐을 때만 미러가 돈다
    } finally {
      unsubscribe();
    }
  });
});
