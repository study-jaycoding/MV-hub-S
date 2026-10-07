// updateScene 반환 계약 — 씬 편집 1회에 저장소를 여러 번 파싱하지 않게 한 변경의 회귀 방지.
//  (호출부 patchSceneById 는 이 반환값을 그대로 화면 상태로 쓴다 → listScenes 재조회 없음.)
//  ★반환값은 '저장된 목록'이다: 저장이 실패하면 ok:false 여야 한다(미저장 편집을 화면에 채택 금지).
//  ★실패는 두 가지다 — storage(저장소가 거부: 편집이 아예 안 남음) / missing(대상 씬이 없어 바뀐 게 없음).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createScene,
  deleteScene,
  hasSceneBucket,
  listScenes,
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

// 저장 성공을 단언하고 목록을 꺼낸다(성공 경로 테스트용).
function saved(result: SceneWriteResult): Scene[] {
  expect(result.ok).toBe(true);
  return result.ok ? result.scenes : [];
}

// 저장소 쓰기가 실패하는 상황(용량 초과·접근 차단) 재현.
async function withFailingWrites<T>(run: () => T | Promise<T>): Promise<T> {
  failSceneStoreWritesForTest(true);
  try {
    return await run();
  } finally {
    failSceneStoreWritesForTest(false);
  }
}

describe("updateScene 반환 계약", () => {
  beforeEach(() => {
    installStorageMocks();
    saveString(STORAGE_KEYS.activeAccount, "a@x.com");
    setAccountScope("a@x.com");
  });
  afterEach(() => {
    delete (globalThis as { sessionStorage?: Storage }).sessionStorage;
  });

  it("갱신된 목록을 반환하고, 그 내용이 저장본과 같다", async () => {
    await saveScenes(null, [mkScene("s1"), mkScene("s2")]);
    const next = saved(await updateScene(null, "s1", { name: "바뀐 이름" }));

    expect(next.map((s) => s.id)).toEqual(["s1", "s2"]); // 순서 보존
    expect(next.find((s) => s.id === "s1")?.name).toBe("바뀐 이름");
    expect(next.find((s) => s.id === "s2")?.name).toBe("s2"); // 다른 씬은 그대로
    expect(next).toEqual(listScenes(null)); // 반환값 = 저장본(호출부가 다시 읽을 필요 없음)
  });

  // 저장소에 쓰는 것과 '요청한 대상을 바꾸는 것'은 다른 성공이다. 종전에는 없는 씬에 쓴 편집도
  // 성공으로 보고해, 호출부가 그 편집을 저장된 것처럼 화면에 남겼다(적대 리뷰 r3).
  it("없는 씬 id 면 missing — 씬을 만들지도, 성공으로 보고하지도 않는다", async () => {
    await saveScenes(null, [mkScene("s1")]);
    const result = await updateScene(null, "gone", { name: "x" });
    expect(result).toEqual({ ok: false, reason: "missing" });
    expect(listScenes(null).map((s) => s.id)).toEqual(["s1"]);
  });

  // 계정 네임스페이스 도입 전의 옛 키(`_none`)는 localStorage→IndexedDB 이관 때 그대로 따라온다.
  // 그 뒤 현재 계정 버킷으로 1회 옮겨져야 한다 — 안 옮기면 다른 계정이 나중에 가져가 버린다.
  it("네임스페이스 도입 전 옛 버킷도 그대로 이관해 갱신한다", async () => {
    await writeScenesStore({ _none: [mkScene("old")] });
    const next = saved(await updateScene(null, "old", { name: "이관됨" }));
    expect(next.map((s) => s.name)).toEqual(["이관됨"]);
    expect(listScenes(null).map((s) => s.name)).toEqual(["이관됨"]);
    expect("_none" in next).toBe(false); // 반환 목록은 계정 버킷의 것
    expect(readScenesCache()._none).toBeUndefined(); // 옛 키는 저장소에서도 제거
  });

  // 저장 실패(용량 초과·접근 차단)를 성공처럼 화면에 반영하면, 사용자는 저장된 줄 알고 새로고침에서
  // 편집을 잃는다. 반환값은 '저장된 목록'이어야 하므로 실패는 ok:false 로 알린다.
  it("저장이 실패하면 storage 로 알리고 저장본은 그대로다", async () => {
    await saveScenes(null, [mkScene("s1")]);
    const result = await withFailingWrites(() => updateScene(null, "s1", { name: "저장 안 된 이름" }));
    expect(result).toEqual({ ok: false, reason: "storage" });
    expect(listScenes(null).map((s) => s.name)).toEqual(["s1"]); // 저장본 불변 = 화면도 되돌아감
  });

  // 2026-10-07 신고의 뿌리: 저장이 실패해도 아무도 알려주지 않아, 사라지는 편집이 '연결 안 되는 버그'로
  // 읽혔다. 알림은 쓰기 관문 하나가 **상태가 바뀔 때만** 내보낸다 — 경로를 빠뜨릴 수 없고, 연속 실패에
  // 매번 띄워 폭주하지도 않는다.
  it("저장 실패·복귀를 상태가 바뀔 때만 알린다", async () => {
    await saveScenes(null, [mkScene("s1")]);
    const seen: boolean[] = [];
    const unsubscribe = subscribeSceneSaveState((failed) => seen.push(failed));
    try {
      await updateScene(null, "s1", { name: "성공1" });
      expect(seen).toEqual([]); // 잘 되는 동안은 조용하다

      await withFailingWrites(async () => {
        await updateScene(null, "s1", { name: "실패1" });
        await updateScene(null, "s1", { name: "실패2" });
      });
      expect(seen).toEqual([true]); // 연속 실패에도 한 번만

      await updateScene(null, "s1", { name: "성공2" });
      await updateScene(null, "s1", { name: "성공3" });
      expect(seen).toEqual([true, false]); // 복귀도 한 번만
    } finally {
      unsubscribe();
    }
  });

  // 부팅 첫 저장(옛 버킷 이관)이 실패하면 화면이 구독하기 전이다. 그때 '상태가 안 바뀌었다'는 이유로
  // 건너뛰면 그 세션 내내 조용하다 — 사용자는 계속 실패하는 편집만 본다(적대 리뷰 P1).
  it("이미 실패 중이면 늦게 구독한 화면에도 바로 알린다", async () => {
    await saveScenes(null, [mkScene("s1")]);
    await withFailingWrites(() => updateScene(null, "s1", { name: "실패" })); // 구독 전에 실패해 둔다
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
  it("대상도 없고 이관할 것도 없으면 빈 버킷을 만들지 않는다", async () => {
    expect(hasSceneBucket(null)).toBe(false);
    expect(await updateScene(null, "gone", { name: "x" })).toEqual({ ok: false, reason: "missing" });
    expect(hasSceneBucket(null)).toBe(false); // 복구 판정이 그대로 열려 있어야 한다
  });

  // ★저장이 비동기가 되며 생긴 위험: 같은 내용을 읽은 두 변경이 각각 저장소 전체를 덮으면 앞선
  // 변경이 사라진다(이름을 바꾸고 바로 카메라를 움직이면 이름이 되돌아감 — Codex 코드 리뷰에서 재현).
  // 쓰기만 줄 세우면 안 되고, '최신을 읽어 변경을 계산하는 것'까지 한 줄이어야 한다.
  it("동시에 들어온 두 변경이 서로를 지우지 않는다", async () => {
    await saveScenes(null, [mkScene("s1")]);
    const [a, b] = await Promise.all([
      updateScene(null, "s1", { name: "이름 바꿈" }),
      updateScene(null, "s1", { camera: { x: 1, y: 2, z: 3 } }),
    ]);
    expect(a.ok && b.ok).toBe(true);
    const saved = listScenes(null)[0];
    expect(saved.name).toBe("이름 바꿈"); // 먼저 들어온 변경이 살아 있다
    expect(saved.camera).toEqual({ x: 1, y: 2, z: 3 });
  });

  it("여러 씬을 동시에 더해도 하나도 빠지지 않는다", async () => {
    await saveScenes(null, []);
    await Promise.all([createScene(null, "가"), createScene(null, "나"), createScene(null, "다")]);
    expect(listScenes(null).map((s) => s.name).sort()).toEqual(["가", "나", "다"]);
  });

  // 종전에는 저장이 실패해도 새 씬을 그대로 돌려줘, 호출부가 목록에 없는 씬을 활성 탭으로 잡았다.
  it("createScene 은 저장 실패면 null — 없는 씬을 돌려주지 않는다", async () => {
    expect(await withFailingWrites(() => createScene(null, "새 씬"))).toBeNull();
    expect(listScenes(null)).toEqual([]);
  });

  // 삭제가 저장되지 않았으면 씬이 그대로 남아 있다 — 호출부가 undo 히스토리를 버리면 안 된다.
  it("deleteScene 은 저장 실패면 false — 씬이 남아 있다", async () => {
    await saveScenes(null, [mkScene("s1")]);
    expect(await withFailingWrites(() => deleteScene(null, "s1"))).toBe(false);
    expect(listScenes(null).map((s) => s.id)).toEqual(["s1"]);
    expect(await deleteScene(null, "s1")).toBe(true);
    expect(listScenes(null)).toEqual([]);
  });

  it("저장이 실패하면 영속 구독자(DB 미러)를 부르지 않는다", async () => {
    await saveScenes(null, [mkScene("s1")]);
    let calls = 0;
    const unsubscribe = subscribeScenesPersisted(() => {
      calls += 1;
    });
    try {
      await withFailingWrites(() => updateScene(null, "s1", { name: "실패" }));
      expect(calls).toBe(0);
      await updateScene(null, "s1", { name: "성공" });
      expect(calls).toBe(1); // 성공했을 때만 미러가 돈다
    } finally {
      unsubscribe();
    }
  });
});
