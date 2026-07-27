// scenes 순수 헬퍼 특성화 — 변형 id·지문(양방향 동기화 안정성 근거).
import { describe, it, expect, beforeEach } from "vitest";
import {
  variantIds,
  sceneRefFingerprint,
  cardBatch,
  listScenes,
  saveScenes,
  getActiveSceneId,
  type Scene,
} from "../src/lib/scenes";
import { saveJSON, saveString } from "../src/lib/storage";
import { STORAGE_KEYS } from "../src/lib/storageKeys";

// node 환경엔 localStorage 가 없어 인메모리 목을 심는다(계정 네임스페이스·이관 검증용).
function installLocalStorageMock() {
  const store: Record<string, string> = {};
  (globalThis as { localStorage?: Storage }).localStorage = {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => { store[k] = String(v); },
    removeItem: (k: string) => { delete store[k]; },
    clear: () => { for (const k of Object.keys(store)) delete store[k]; },
    key: (i: number) => Object.keys(store)[i] ?? null,
    get length() { return Object.keys(store).length; },
  } as Storage;
}
const mkScene = (id: string): Scene => ({ id, name: id, cards: [], edges: [], created_at: 1 });

describe("scenes 계정 네임스페이스", () => {
  beforeEach(installLocalStorageMock);

  it("계정별로 씬이 분리된다(전환해도 안 섞임, 되돌아오면 복원)", () => {
    saveString(STORAGE_KEYS.activeAccount, "a@x.com");
    saveScenes(null, [mkScene("A1")]);
    expect(listScenes(null).map((s) => s.id)).toEqual(["A1"]);

    saveString(STORAGE_KEYS.activeAccount, "b@x.com"); // 계정 전환
    expect(listScenes(null)).toEqual([]); // A 씬 안 보임
    saveScenes(null, [mkScene("B1")]);

    saveString(STORAGE_KEYS.activeAccount, "a@x.com"); // 되돌아옴
    expect(listScenes(null).map((s) => s.id)).toEqual(["A1"]); // A 씬 복원
  });

  it("네임스페이스 이전(레거시 _none) 씬을 현재 계정으로 1회 이관하고 옛 키는 제거", () => {
    saveJSON(STORAGE_KEYS.scenes, { _none: [mkScene("OLD")] }); // 옛 데이터
    saveString(STORAGE_KEYS.activeAccount, "a@x.com");
    expect(listScenes(null).map((s) => s.id)).toEqual(["OLD"]); // 현재 계정으로 이관돼 보임

    // 다른 계정은 이관된 옛 씬을 다시 가져가지 않는다(옛 키 제거됨).
    saveString(STORAGE_KEYS.activeAccount, "b@x.com");
    expect(listScenes(null)).toEqual([]);
  });

  it("로그인 없음(AUTH off 로컬)은 local 네임스페이스로 유지", () => {
    saveJSON(STORAGE_KEYS.scenes, { _none: [mkScene("LOCAL")] });
    // activeAccount 없음
    expect(listScenes(null).map((s) => s.id)).toEqual(["LOCAL"]); // 로컬도 옛 씬 유지(이관)
    expect(getActiveSceneId(null)).toBeNull();
  });
});

describe("cardBatch", () => {
  it("기본값 1, 정상값 유지", () => {
    expect(cardBatch(undefined)).toBe(1);
    expect(cardBatch({})).toBe(1);
    expect(cardBatch({ batchCount: 3 })).toBe(3);
  });
  it("범위·비정상값 안전화(1~4 정수)", () => {
    expect(cardBatch({ batchCount: 99 })).toBe(4); // 손상/임포트 상한 clamp
    expect(cardBatch({ batchCount: 0 })).toBe(1);
    expect(cardBatch({ batchCount: 2.9 })).toBe(2); // 정수화
    expect(cardBatch({ batchCount: NaN })).toBe(1);
    expect(cardBatch({ batchCount: "x" as unknown as number })).toBe(1);
  });
});

describe("variantIds", () => {
  it("genIds 가 있으면 그것을(순서 보존)", () => {
    expect(variantIds({ genIds: ["a", "b"], genId: "b" })).toEqual(["a", "b"]);
  });
  it("genIds 없고 genId 만 있으면 [genId]", () => {
    expect(variantIds({ genIds: undefined, genId: "solo" })).toEqual(["solo"]);
  });
  it("둘 다 없으면 빈 배열", () => {
    expect(variantIds({ genIds: undefined, genId: null })).toEqual([]);
  });
});

describe("sceneRefFingerprint", () => {
  it("같은 refs 는 같은 지문(안정)", () => {
    const refs = [{ file_path: "a", type: "image", name: "n", thumb: "t", source_gen_id: "g" }];
    expect(sceneRefFingerprint(refs)).toBe(sceneRefFingerprint([...refs]));
  });
  it("빈 값 정규화: name/thumb/source_gen_id 누락은 '' 로", () => {
    const a = sceneRefFingerprint([{ file_path: "a", type: "image" }]);
    const b = sceneRefFingerprint([
      { file_path: "a", type: "image", name: "", thumb: "", source_gen_id: "" },
    ]);
    expect(a).toBe(b);
  });
  it("순서·내용이 다르면 지문 다름", () => {
    const one = sceneRefFingerprint([{ file_path: "a", type: "image" }]);
    const two = sceneRefFingerprint([{ file_path: "b", type: "image" }]);
    expect(one).not.toBe(two);
  });
});
