// 씬 저장 입구 모양 검사(2026-11-12) — 11-10 한 씬이 (카드, 연결선, 묶음) → (카드, 카드, 연결선)으로 한 칸씩 밀려 저장돼
//  연결선을 잃었다. 쓴 코드는 못 찾았다 → 이미 있던 씬의 '모양이 틀린 항목'을 늘리는 쓰기는 접수하지 않고, 재생 때 늘면 버린다.
//  새 씬과 이미 깨진 만큼은 막지 않는다(기록 docs/status/캔버스_저장입구모양검사_2026-11-12.md).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  confirmSceneWrite,
  listPersistedScenes,
  listScenes,
  mergeScenesFromBackup,
  saveScenes,
  subscribeSceneSaveState,
  subscribeSceneShapeRefused,
  updateScene,
  type Scene,
  type SceneCard,
  type SceneEdge,
  type SceneGroup,
} from "../src/lib/scenes";
import {
  delaySceneStoreWritesForTest,
  failSceneStoreWritesForTest,
  readSceneStoreForClose,
  sceneStoreLoadForTest,
  sceneNotebookTransaction,
  settleSceneStoreForTest,
  writeSceneStoreAsOtherWindowForTest,
} from "../src/lib/sceneStore";
import { setHubFeatures } from "../src/lib/hubFeatures";
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

const card = (id: string): SceneCard => ({ id, kind: "text", x: 0, y: 0 });
const edge = (id: string, from: string, to: string): SceneEdge => ({ id, from, to });
const group = (id: string, cardIds: string[]): SceneGroup => ({ id, name: id, cardIds });
const cards = [card("a"), card("b"), card("c")];
const edges = [edge("e1", "a", "b"), edge("e2", "b", "c")];
const groups = [group("g1", ["a", "b"])];
const healthy = (id = "s1"): Scene => ({ id, name: id, cards, edges, groups, created_at: 1 });
// 11-10 모양 — 연결선 칸에 카드, 묶음 칸에 연결선
const shifted = { cards, edges: cards as unknown as SceneEdge[], groups: edges as unknown as SceneGroup[] };
const cardEdges = cards as unknown as SceneEdge[]; // 지금 DB 의 part2 처럼 연결선 칸에 카드가 든 모양(틀린 항목 3)
const fixP2 = (all: Record<string, Scene[]>) => {
  for (const key of Object.keys(all)) all[key] = all[key].map((scene) => (scene.id === "p2" ? { ...scene, edges } : scene));
};

let clock = 1_000_000;
describe("씬 저장 입구 모양 검사", () => {
  let errors: ReturnType<typeof vi.spyOn>;
  let refused: string[];
  let unsubscribe: () => void;
  beforeEach(async () => {
    (globalThis as { localStorage?: Storage }).localStorage = storageMock();
    (globalThis as { sessionStorage?: Storage }).sessionStorage = storageMock();
    saveString(STORAGE_KEYS.activeAccount, "a@x.com");
    setAccountScope("a@x.com");
    // 알림은 10초에 한 번(모듈 상태) — 시험마다 시계를 11초씩 밀어 앞 시험의 알림에 묶이지 않게
    vi.useFakeTimers({ toFake: ["Date"] });
    clock += 11_000;
    vi.setSystemTime(clock);
    refused = [];
    unsubscribe = subscribeSceneShapeRefused((refusal) => refused.push(refusal.name));
    errors = vi.spyOn(console, "error").mockImplementation(() => {});
    saveScenes(null, [healthy()]);
    expect(await settleSceneStoreForTest()).toBe(true);
  });
  afterEach(async () => {
    unsubscribe();
    vi.useRealTimers();
    failSceneStoreWritesForTest(false);
    setHubFeatures([]);
    await settleSceneStoreForTest(); // 남은 대기 편집이 여기서 거절될 수 있다 — 기록 가로채기는 그 뒤에 푼다
    errors.mockRestore();
    delete (globalThis as { sessionStorage?: Storage }).sessionStorage;
  });

  it("11-10 모양(카드·카드·연결선)으로 덮는 쓰기는 거절하고 화면 값·확정본이 그대로다", async () => {
    const { value, confirmed } = confirmSceneWrite(() => updateScene(null, "s1", shifted));
    expect(value).toEqual({ ok: false, reason: "shape" });
    expect(await confirmed).toBe(false);
    expect(listScenes(null)[0].edges).toEqual(edges);
    expect(listScenes(null)[0].groups).toEqual(groups);
    expect(await settleSceneStoreForTest()).toBe(true);
    expect(listPersistedScenes(null)[0].edges).toEqual(edges);
    expect(listPersistedScenes(null)[0].groups).toEqual(groups);
    expect(refused).toEqual(["s1"]);
    expect(errors).toHaveBeenCalledTimes(1);
  });

  it("묶음 칸만 연결선으로 바뀐 쓰기도 거절한다", () => {
    expect(updateScene(null, "s1", { groups: edges as unknown as SceneGroup[] })).toEqual({ ok: false, reason: "shape" });
    expect(listScenes(null)[0].groups).toEqual(groups);
  });

  it("목록을 통째로 놓는 쓰기로 같은 손상을 넣어도 거절한다", () => {
    expect(saveScenes(null, [{ ...healthy(), ...shifted }])).toBe(false);
    expect(listScenes(null)[0].edges).toEqual(edges);
  });

  it("알림과 기록은 10초에 한 번 — 연달아 거절해도 넘치지 않는다", () => {
    updateScene(null, "s1", shifted);
    updateScene(null, "s1", shifted);
    expect(refused).toHaveLength(1);
    expect(errors).toHaveBeenCalledTimes(1);
    vi.setSystemTime(clock + 11_000);
    updateScene(null, "s1", shifted);
    expect(refused).toHaveLength(2);
  });

  it("정상 편집(더하기·빼기·고치기)은 그대로 저장된다", async () => {
    const next = {
      cards: [...cards, card("d")],
      edges: [edge("e2", "b", "c"), edge("e3", "c", "d")],
      groups: [group("g1", ["a"]), group("g2", ["c", "d"])],
    };
    expect(updateScene(null, "s1", next).ok).toBe(true);
    expect(updateScene(null, "s1", { name: "이름", camera: { x: 1, y: 2, z: 1 } }).ok).toBe(true);
    expect(await settleSceneStoreForTest()).toBe(true);
    expect(listPersistedScenes(null)[0].edges).toEqual(next.edges);
    expect(listPersistedScenes(null)[0].groups).toEqual(next.groups);
    expect(refused).toEqual([]);
  });

  it("이미 깨진 씬은 틀린 항목이 같거나 줄면 저장된다", async () => {
    saveScenes(null, [{ ...healthy("broken"), edges: cards as unknown as SceneEdge[] }]); // 지금 DB 의 part2 와 같은 모양(앞 씬을 지운 새 씬이라 통과)
    expect(await settleSceneStoreForTest()).toBe(true);
    expect(updateScene(null, "broken", { name: "이름만 바꿈" }).ok).toBe(true); // 3 → 3
    expect(updateScene(null, "broken", { cards: [...cards, card("d")] }).ok).toBe(true); // 카드만 더함 — 3 → 3
    expect(updateScene(null, "broken", { edges: cards.slice(1) as unknown as SceneEdge[] }).ok).toBe(true); // 3 → 2
    expect(updateScene(null, "broken", { edges }).ok).toBe(true); // 2 → 0(정리)
    expect(await settleSceneStoreForTest()).toBe(true);
    expect(listPersistedScenes(null)[0].edges).toEqual(edges);
    expect(refused).toEqual([]);
  });

  it("새 씬은 틀린 항목이 있어도 막지 않는다 — 백업 복구가 깨진 씬 하나 때문에 통째로 막히지 않게", () => {
    const { ok, added } = mergeScenesFromBackup(null, [{ ...healthy("from-db"), ...shifted }, healthy("ok-db")]);
    expect(ok).toBe(true);
    expect(added.map((s) => s.id)).toEqual(["from-db", "ok-db"]);
    expect(refused).toEqual([]);
  });

  // Codex 설계 검토 P1 — 접수 때는 이미 깨진 씬이라(3 → 3) 통과한 연산이, 다른 창이 그사이 고친 저장본 위에서는 0 → 3 이 된다.
  it("다른 창이 고친 저장본 위에서 재생하면 틀린 항목을 늘리는 연산은 버리고 고친 내용을 지킨다", async () => {
    saveScenes(null, [{ ...healthy("p2"), edges: cardEdges }]);
    expect(await settleSceneStoreForTest()).toBe(true);
    const { value, confirmed } = confirmSceneWrite(() => updateScene(null, "p2", { name: "이 창 편집", edges: cardEdges }));
    expect(value.ok).toBe(true); // 접수 때는 3 → 3
    writeSceneStoreAsOtherWindowForTest(fixP2);
    expect(await settleSceneStoreForTest()).toBe(true);
    expect(await confirmed).toBe(false);
    expect(listPersistedScenes(null)[0].edges).toEqual(edges); // 다른 창이 고친 그대로
    expect(listPersistedScenes(null)[0].name).toBe("p2");
    expect(listScenes(null)[0].edges).toEqual(edges); // 화면 값도 다시 계산돼 버린 연산이 빠진다
    expect(refused).toEqual(["p2"]);
  });

  // 실패한 저장 뒤 다시 합쳐진 연산(sceneStore.compactPending)도 한 연산으로 판정된다 — 접수 때 합쳐진 연산(위 시험의 한 패치)과 같은 결과:
  //  합쳐진 입력 가운데 하나가 틀린 항목을 늘리면 그 연산 전체를 버리고 고친 내용을 지킨다(이름 편집만 살리지 않는다).
  it("실패한 저장 뒤 합쳐진 연산이 재생 모양 검사에 걸리면 접수 때 합쳐진 연산처럼 통째로 버린다", async () => {
    saveScenes(null, [{ ...healthy("p2"), edges: cardEdges }]);
    expect(await settleSceneStoreForTest()).toBe(true);
    failSceneStoreWritesForTest(true);
    delaySceneStoreWritesForTest(10);
    updateScene(null, "p2", { name: "이 창 편집" });
    const attempt = settleSceneStoreForTest(); // 이름 편집이 저장으로 떠난다(실패할 것)
    await Promise.resolve();
    expect(updateScene(null, "p2", { edges: cardEdges }).ok).toBe(true); // 떠난 사이 — 따로 연산(접수 3 → 3)
    expect(await attempt).toBe(false); // 실패 → 두 연산이 다시 하나로
    expect(sceneStoreLoadForTest().pending).toBe(1);
    delaySceneStoreWritesForTest(0);
    failSceneStoreWritesForTest(false);
    writeSceneStoreAsOtherWindowForTest(fixP2);
    expect(await settleSceneStoreForTest()).toBe(true);
    expect(listPersistedScenes(null)[0].edges).toEqual(edges); // 다른 창이 고친 그대로
    expect(listPersistedScenes(null)[0].name).toBe("p2"); // 합쳐진 연산 전체가 빠졌다
    expect(listScenes(null)[0].edges).toEqual(edges);
    expect(refused).toEqual(["p2"]);
  });

  // Codex 리뷰 P2 — 알림 칸은 하나라(useAppToast) 뒤에 온 것이 남는다. 재시도 중 거절이 나오면 같은 확정의 '저장 다시 정상'이 거절 경고를 덮었다.
  it("재생 거절 알림은 같은 확정의 '저장 다시 정상' 알림 뒤에 온다", async () => {
    saveScenes(null, [{ ...healthy("p2"), edges: cardEdges }]);
    expect(await settleSceneStoreForTest()).toBe(true);
    const order: string[] = [];
    const offSave = subscribeSceneSaveState((failed) => order.push(failed ? "저장 실패" : "저장 정상"));
    const offShape = subscribeSceneShapeRefused(() => order.push("모양 거절"));
    try {
      failSceneStoreWritesForTest(true);
      updateScene(null, "p2", { name: "이 창 편집", edges: cardEdges }); // 접수 3 → 3
      expect(await settleSceneStoreForTest()).toBe(false);
      failSceneStoreWritesForTest(false);
      writeSceneStoreAsOtherWindowForTest(fixP2);
      expect(await settleSceneStoreForTest()).toBe(true); // 재시도 — 고친 저장본 위 재생에서 거절, 확정은 성공
      expect(order).toEqual(["저장 실패", "저장 정상", "모양 거절"]);
    } finally {
      offSave();
      offShape();
    }
  });

  // Codex 리뷰 P1 — 허브가 고친 판을 들이는 사이에 옛 화면 값(이미 깨짐) 위에서 접수된 편집이 대기에 남은 채 창을 닫으면,
  //  닫기 전송의 재생(readSceneStoreForClose)이 고친 확정본 위에서 0 → 3 을 검사 없이 실었다.
  it("닫기 전송 재생도 같은 판정 — 고친 확정본 위에서 틀린 항목을 늘리는 대기 편집은 싣지 않는다", async () => {
    setHubFeatures(["scene_writer_v1"]);
    saveScenes(null, [{ ...healthy("p2"), edges: cardEdges }]);
    expect(await settleSceneStoreForTest()).toBe(true); // 공책 모드 확정 — 닫기 재생의 기준이 생긴다
    const out = await sceneNotebookTransaction([], (all) => {
      fixP2(all); // 허브가 고친 판
      failSceneStoreWritesForTest(true); // 이 뒤 저장은 실패 — 아래 편집이 대기에 남는다
      updateScene(null, "p2", { name: "이 창 편집", edges: cardEdges }); // 고친 판이 확정되기 전 옛 화면 값 위에서 접수(3 → 3)
      return { value: null, changed: true };
    });
    expect(out.ok).toBe(true);
    const snapshot = readSceneStoreForClose();
    expect(snapshot).not.toBeNull();
    const p2 = Object.values(snapshot!.scenes).flat().find((scene) => scene.id === "p2");
    expect(p2?.edges).toEqual(edges);
  });
});
