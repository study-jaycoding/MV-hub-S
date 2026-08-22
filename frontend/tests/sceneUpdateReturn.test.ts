// updateScene 반환 계약 — 씬 편집 1회에 저장소를 여러 번 파싱하지 않게 한 변경의 회귀 방지.
//  (호출부 patchSceneById 는 이 반환값을 그대로 화면 상태로 쓴다 → listScenes 재조회 없음.)
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listScenes, saveScenes, updateScene, type Scene } from "../src/lib/scenes";
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

// 씬 버킷을 몇 번 읽었는지(=몇 번 파싱했는지) 센다.
function countSceneReads<T>(run: () => T): { result: T; reads: number } {
  const raw = localStorage.getItem.bind(localStorage);
  let reads = 0;
  localStorage.getItem = (k: string) => {
    if (k === STORAGE_KEYS.scenes) reads += 1;
    return raw(k);
  };
  try {
    return { result: run(), reads };
  } finally {
    localStorage.getItem = raw;
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

  it("갱신된 목록을 반환하고, 그 내용이 저장본과 같다", () => {
    saveScenes(null, [mkScene("s1"), mkScene("s2")]);
    const next = updateScene(null, "s1", { name: "바뀐 이름" });

    expect(next.map((s) => s.id)).toEqual(["s1", "s2"]); // 순서 보존
    expect(next.find((s) => s.id === "s1")?.name).toBe("바뀐 이름");
    expect(next.find((s) => s.id === "s2")?.name).toBe("s2"); // 다른 씬은 그대로
    expect(next).toEqual(listScenes(null)); // 반환값 = 저장본(호출부가 다시 읽을 필요 없음)
  });

  it("저장소를 한 번만 읽는다(예전 경로는 listScenes+saveScenes 로 2번, 호출부 재조회까지 3번)", () => {
    saveScenes(null, [mkScene("s1")]);
    const { reads } = countSceneReads(() => updateScene(null, "s1", { name: "x" }));
    expect(reads).toBe(1);
  });

  it("없는 씬 id 면 아무 씬도 만들지 않는다(기존 동작 유지)", () => {
    saveScenes(null, [mkScene("s1")]);
    const next = updateScene(null, "gone", { name: "x" });
    expect(next.map((s) => s.id)).toEqual(["s1"]);
    expect(listScenes(null).map((s) => s.id)).toEqual(["s1"]);
  });

  it("네임스페이스 도입 전 옛 버킷도 그대로 이관해 갱신한다", () => {
    // 옛 키(프로젝트 id 단독)에 저장된 씬 — 계정 버킷으로 옮겨진 뒤 patch 가 적용돼야 한다.
    localStorage.setItem(STORAGE_KEYS.scenes, JSON.stringify({ _none: [mkScene("old")] }));
    const next = updateScene(null, "old", { name: "이관됨" });
    expect(next.map((s) => s.name)).toEqual(["이관됨"]);
    expect(listScenes(null).map((s) => s.name)).toEqual(["이관됨"]);
    const all = JSON.parse(localStorage.getItem(STORAGE_KEYS.scenes) || "{}");
    expect(all._none).toBeUndefined(); // 옛 키는 제거(다른 계정이 재귀속하지 않게)
  });
});
