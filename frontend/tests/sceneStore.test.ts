// 씬 저장소(IndexedDB 계층)의 계약 — 이관 표식과 충돌 보존.
// 진짜 IndexedDB 는 jsdom 에 없어 메모리 대체 경로로 돈다. 실제 IDB 동작은 frontend/measure 의
// 브라우저 실측이 따로 확인한다(이관·용량·지연·흡수).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  absorbLegacyScenes,
  initSceneStore,
  readScenesCache,
  resetSceneStoreForTest,
  sceneStoreConflicts,
  setSceneWriteGate,
  writeScenesStore,
  type LegacyMark,
} from "../src/lib/sceneStore";
import type { Scene, ScenesByProject } from "../src/lib/scenes";

const scene = (id: string, name = id): Scene => ({ id, name, cards: [], edges: [], created_at: 1 });
const bucket = (...s: Scene[]): ScenesByProject => ({ acct: s });

function markStore() {
  let mark: LegacyMark | null = null;
  let failWrite = false;
  return {
    read: () => mark,
    write: (next: LegacyMark) => {
      if (failWrite) return false;
      mark = next;
      return true;
    },
    get value() {
      return mark;
    },
    blockWrites() {
      failWrite = true;
    },
  };
}

describe("씬 저장소 — 이관 표식", () => {
  beforeEach(() => resetSceneStoreForTest());

  it("처음 열면 옛 저장소를 통째로 가져오고 표식을 committed 로 남긴다", async () => {
    const mark = markStore();
    const result = await initSceneStore(() => bucket(scene("s1")), mark.read(), mark.write);
    expect(result.kind).toBe("ready");
    expect(result.kind === "ready" && result.migrated).toBe(true);
    expect(readScenesCache().acct.map((s) => s.id)).toEqual(["s1"]);
    expect(mark.value).toEqual({ state: "committed", generation: expect.any(String) });
  });

  // 표식이 조용히 안 남으면 다음 실행이 '처음 이관'으로 보고 그 사이의 작업을 옛 내용으로 덮는다.
  it("표식을 남기지 못하면 이관하지 않고 실패로 알린다", async () => {
    const mark = markStore();
    mark.blockWrites();
    const result = await initSceneStore(() => bucket(scene("s1")), mark.read(), mark.write);
    expect(result.kind).toBe("failed");
  });

  // 'pending' = 첫 이관이 끊겼다 → 옛 저장소가 아직 정답이므로 다시 이관해야 한다.
  // 이것을 'IDB 소실'과 섞으면 자료가 있는데 빈 상태로 연다(Codex 코드 리뷰에서 재현).
  it("표식이 pending 이면(이관이 끊김) 다시 이관한다", async () => {
    const mark = markStore();
    const result = await initSceneStore(
      () => bucket(scene("s1")),
      { state: "pending", generation: "g1" },
      mark.write,
    );
    expect(result.kind === "ready" && result.migrated).toBe(true);
    expect(readScenesCache().acct.map((s) => s.id)).toEqual(["s1"]);
  });

  // 'committed' 인데 저장소가 비었다 = 이관 뒤 IDB 가 사라졌다. 옛 저장소를 최신으로 되살리면
  // 이관 뒤의 작업이 통째로 옛 상태로 돌아간다 — 되살리지 않고 DB 백업 복구에 맡긴다.
  it("표식이 committed 인데 저장소가 비었으면 옛 내용을 되살리지 않는다", async () => {
    const mark = markStore();
    const result = await initSceneStore(
      () => bucket(scene("s1")),
      { state: "committed", generation: "g1" },
      mark.write,
    );
    expect(result.kind === "ready" && result.migrated).toBe(false);
    expect(readScenesCache()).toEqual({});
  });
});

describe("씬 저장소 — 충돌 보존", () => {
  beforeEach(() => resetSceneStoreForTest());

  // 기준(B)은 흡수 뒤 최신으로 올라가므로, 저장해 두지 않으면 다시 열 때 충돌이 조용히 사라진다.
  it("충돌은 다시 열어도 남는다", async () => {
    const mark = markStore();
    await initSceneStore(() => bucket(scene("s1", "원래")), mark.read(), mark.write);

    await writeScenesStore(bucket(scene("s1", "내 수정")));
    const plan = await absorbLegacyScenes(bucket(scene("s1", "옛 창 수정")));
    expect(plan?.conflicts).toHaveLength(1);
    expect(sceneStoreConflicts()).toHaveLength(1);

    // 같은 내용으로 다시 열면 L=B 라 새 충돌은 안 잡힌다 — 저장된 것이 남아 있어야 한다.
    const again = await initSceneStore(
      () => bucket(scene("s1", "옛 창 수정")),
      mark.read(),
      mark.write,
    );
    expect(again.kind).toBe("ready");
    expect(sceneStoreConflicts()).toHaveLength(1);
    expect(readScenesCache().acct[0].name).toBe("내 수정"); // 자동으로 덮지 않는다
  });
});

describe("씬 저장소 — 다른 창에 캔버스가 떠 있는 동안의 부팅", () => {
  beforeEach(() => resetSceneStoreForTest());
  afterEach(() => setSceneWriteGate(() => false));

  // 떠 있는 창이 옛 저장소를 이미 흡수했는데, 이 창이 부팅에서 먼저 읽어 둔 낡은 원문을 흡수하면 그 내용을 되돌린다.
  it("쓰기가 멈춘 동안은 옛 저장소를 흡수하지 않고 기준·충돌도 그대로다", async () => {
    const mark = markStore();
    await initSceneStore(() => bucket(scene("s1", "원래")), mark.read(), mark.write);
    const absorbed = await absorbLegacyScenes(bucket(scene("s1", "떠 있는 창이 흡수한 글")));
    expect(absorbed?.changed).toBe(true);
    setSceneWriteGate(() => true);
    const again = await initSceneStore(() => bucket(scene("s1", "원래")), mark.read(), mark.write);
    expect(again.kind === "ready" && again.absorbed).toBeNull();
    expect(readScenesCache().acct[0].name).toBe("떠 있는 창이 흡수한 글");
    expect(sceneStoreConflicts()).toEqual([]);
    setSceneWriteGate(() => false);
    await absorbLegacyScenes(bucket(scene("s1", "떠 있는 창이 흡수한 글"))); // 기준이 그대로라 옛 저장소 변경은 나중에도 따라잡는다
    expect(sceneStoreConflicts()).toEqual([]);
  });

  it("멈추지 않았으면 부팅 때 그대로 흡수한다", async () => {
    const mark = markStore();
    await initSceneStore(() => bucket(scene("s1", "원래")), mark.read(), mark.write);
    const again = await initSceneStore(() => bucket(scene("s1", "옛 창 수정")), mark.read(), mark.write);
    expect(again.kind === "ready" && again.absorbed?.changed).toBe(true);
    expect(readScenesCache().acct[0].name).toBe("옛 창 수정");
  });

  it("첫 이관은 쓰기가 멈춰 있어도 그대로 옮긴다", async () => {
    setSceneWriteGate(() => true);
    const mark = markStore();
    const first = await initSceneStore(() => bucket(scene("s1")), mark.read(), mark.write);
    expect(first.kind === "ready" && first.migrated).toBe(true);
    expect(readScenesCache().acct.map((s) => s.id)).toEqual(["s1"]);
  });
});
