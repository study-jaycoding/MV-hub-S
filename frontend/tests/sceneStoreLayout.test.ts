// 씬 저장소의 배치 — 씬 하나가 한 키(2026-10-07).
//
// 종전에는 씬 묶음 전체가 한 값이라 편집 한 번마다 전부를 읽고 전부를 다시 썼다(화면 멈춤이 전체 양에 비례).
// 이제 바뀐 씬만 쓴다. 이 시험이 지키는 것:
//  · 편집 한 번이 **그 씬만** 쓴다(전체 크기에 매이지 않는다).
//  · 씬·순서·버전은 전부 되거나 전부 안 된다 — 실패한 저장이 확정본으로 읽히지 않는다.
//  · 옛 배치로 저장된 자료를 잃지 않고 푼다.
// 진짜 IndexedDB(중단·두 창·옛 판 창이 떠 있는 채로 열기)는 frontend/measure 의 브라우저 실측이 본다.
import { afterEach, describe, expect, it } from "vitest";
import {
  abortSceneStoreWritesForTest,
  applySceneOp,
  dumpSceneStore,
  failSceneStoreWritesForTest,
  initSceneStore,
  lastSceneStoreWriteForTest,
  readConfirmedBucket,
  readScenesCache,
  readWorkingBucket,
  replaceSceneStoreForTest,
  resetSceneStoreForTest,
  sceneStoreConflicts,
  sceneStoreHasPending,
  sceneStoreKeysForTest,
  seedLegacyLayoutForTest,
  settleSceneStoreForTest,
  writeSceneStoreAsOtherWindowForTest,
  writeScenesStore,
  type LegacyMark,
} from "../src/lib/sceneStore";
import type { Scene, ScenesByProject } from "../src/lib/scenes";

const scene = (id: string, name = id): Scene => ({ id, name, cards: [], edges: [], created_at: 1 });
const names = (list: Scene[]) => list.map((s) => s.name);
const edit = (mutate: (all: ScenesByProject) => void) =>
  applySceneOp((all) => {
    mutate(all);
    return { write: true, value: null };
  });
// 없는 씬이면 아무것도 하지 않는다(scenes.updateScene 과 같다 — 재생 때 대상이 사라져 있을 수 있다).
const rename = (id: string, name: string) =>
  edit((all) => {
    if (!all.acct?.some((s) => s.id === id)) return;
    all.acct = all.acct.map((s) => (s.id === id ? { ...s, name } : s));
  });
const committed: LegacyMark = { state: "committed", generation: "g1" };
const keepMark = () => true;

afterEach(() => {
  failSceneStoreWritesForTest(false);
  abortSceneStoreWritesForTest(false);
});

describe("씬별 키 — 바뀐 것만 쓴다", () => {
  it("씬 하나를 고치면 그 씬만 쓴다 — 다른 씬·순서는 건드리지 않는다", async () => {
    await writeScenesStore({ acct: [scene("s1"), scene("s2"), scene("s3")], other: [scene("o1")] });
    rename("s2", "고침");
    expect(await settleSceneStoreForTest()).toBe(true);
    expect(lastSceneStoreWriteForTest()).toEqual({ scenes: ["acct/s2"], orders: [], deleted: [] });
    expect(names(readConfirmedBucket("acct"))).toEqual(["s1", "고침", "s3"]);
  });

  it("더하기·지우기·순서 바꾸기는 그 씬과 순서만 쓴다", async () => {
    await writeScenesStore({ acct: [scene("s1"), scene("s2")] });

    edit((all) => {
      all.acct = [...all.acct, scene("s3")];
    });
    await settleSceneStoreForTest();
    expect(lastSceneStoreWriteForTest()).toEqual({ scenes: ["acct/s3"], orders: ["acct"], deleted: [] });

    edit((all) => {
      all.acct = all.acct.filter((s) => s.id !== "s1");
    });
    await settleSceneStoreForTest();
    expect(lastSceneStoreWriteForTest()).toEqual({ scenes: [], orders: ["acct"], deleted: ["acct/s1"] });

    edit((all) => {
      all.acct = [...all.acct].reverse();
    });
    await settleSceneStoreForTest();
    expect(lastSceneStoreWriteForTest()).toEqual({ scenes: [], orders: ["acct"], deleted: [] });
    expect(names(readConfirmedBucket("acct"))).toEqual(["s3", "s2"]);
  });

  it("버킷을 옮기면(계정 귀속) 옛 버킷의 키를 지우고 새 버킷에 쓴다", async () => {
    await writeScenesStore({ _none: [scene("old1"), scene("old2")] });
    edit((all) => {
      all.acct = all._none;
      delete all._none;
    });
    await settleSceneStoreForTest();
    const write = lastSceneStoreWriteForTest();
    expect(write.scenes.sort()).toEqual(["acct/old1", "acct/old2"]);
    expect(write.orders).toEqual(["acct"]);
    expect(write.deleted.sort()).toEqual(["_none", "_none/old1", "_none/old2"]);
    expect(Object.keys(readScenesCache())).toEqual(["acct"]);
  });

  // '빈 배열 버킷'(다 지웠다)과 '버킷 없음'(한 번도 안 썼다)은 DB 자동복구 판정에서 뜻이 다르다.
  it("빈 버킷은 빈 버킷으로 남는다 — 다시 열어도 '버킷 없음'이 되지 않는다", async () => {
    await initSceneStore(() => ({ acct: [scene("s1")] }), null, keepMark);
    edit((all) => {
      all.acct = [];
    });
    await settleSceneStoreForTest();
    expect(sceneStoreKeysForTest()).toContain(JSON.stringify(["o", "acct"]));
    expect(sceneStoreKeysForTest()).not.toContain(JSON.stringify(["s", "acct", "s1"]));

    await initSceneStore(() => ({ acct: [scene("s1")] }), committed, keepMark); // 다시 켠다(옛 저장소는 그대로다)
    expect(readScenesCache()).toEqual({ acct: [] }); // 옛 저장소의 s1 을 되살리지 않는다
  });

  it("저장할 것이 없는 연산은 버전을 올리지 않는다 — 다른 창이 까닭 없이 다시 읽지 않게", async () => {
    await writeScenesStore({ acct: [scene("s1")] });
    const before = sceneStoreKeysForTest().length;
    edit((all) => {
      all.acct = all.acct.map((s) => s); // 새 배열이지만 같은 씬·같은 순서
    });
    expect(await settleSceneStoreForTest()).toBe(true);
    expect(lastSceneStoreWriteForTest()).toEqual({ scenes: [], orders: [], deleted: [] });
    expect(sceneStoreKeysForTest()).toHaveLength(before);
  });
});

describe("씬별 키 — 전부 되거나 전부 안 된다", () => {
  // 재생은 작업본에만 한다. 실패한 저장의 결과가 확정본으로 읽히면 DB 미러가 저장되지 않은 편집을 올리고,
  // 복구 판정이 그것을 믿는다(Codex 설계 검토).
  it("쓰기를 낸 뒤 중단돼도 확정본과 저장소는 그대로다 — 다시 받으면 한 번에 들어간다", async () => {
    await writeScenesStore({ acct: [scene("s1"), scene("s2")] });
    const keysBefore = sceneStoreKeysForTest().sort();

    abortSceneStoreWritesForTest(true);
    rename("s1", "중단된 편집");
    edit((all) => {
      all.acct = [...all.acct, scene("s3")];
    });
    expect(await settleSceneStoreForTest()).toBe(false);
    expect(names(readWorkingBucket("acct"))).toEqual(["중단된 편집", "s2", "s3"]); // 화면에는 남는다
    expect(names(readConfirmedBucket("acct"))).toEqual(["s1", "s2"]); // 확정본은 그대로
    expect(sceneStoreKeysForTest().sort()).toEqual(keysBefore); // 씬도 순서도 반쯤 남지 않았다

    abortSceneStoreWritesForTest(false);
    expect(await settleSceneStoreForTest()).toBe(true);
    expect(names(readConfirmedBucket("acct"))).toEqual(["중단된 편집", "s2", "s3"]);
  });

  it("실패한 뒤 다른 창이 썼어도, 다시 받을 때 그 위에 얹힌다", async () => {
    await writeScenesStore({ acct: [scene("s1")] });
    failSceneStoreWritesForTest(true);
    rename("s1", "막힌 동안 고침");
    expect(await settleSceneStoreForTest()).toBe(false);
    writeSceneStoreAsOtherWindowForTest((all) => {
      all.acct = [...all.acct, scene("other", "다른 창이 만든 씬")];
    });
    failSceneStoreWritesForTest(false);
    expect(await settleSceneStoreForTest()).toBe(true);
    expect(names(readConfirmedBucket("acct"))).toEqual(["막힌 동안 고침", "다른 창이 만든 씬"]);
    expect(lastSceneStoreWriteForTest().scenes).toEqual(["acct/s1"]); // 다른 창의 씬을 다시 쓰지 않는다
  });

  // 저장은 '객체가 같으면 안 바뀐 것'으로 본다. 연산이 씬을 제자리에서 고치면 저장에서 빠진다 — 그래서 개발·시험
  // 빌드에서는 저장소에 든 씬을 얼려, 그런 연산이 조용히 지나가지 않고 그 자리에서 던지게 한다.
  it("저장소에 든 씬을 제자리에서 고치는 연산은 던진다(개발·시험 빌드)", async () => {
    await writeScenesStore({ acct: [scene("s1")] });
    expect(() =>
      edit((all) => {
        all.acct[0].name = "제자리 수정";
      }),
    ).toThrow(TypeError);
    expect(() =>
      edit((all) => {
        all.acct.push(scene("s2"));
      }),
    ).toThrow(TypeError);
    expect(names(readWorkingBucket("acct"))).toEqual(["s1"]);
  });
});

describe("옛 배치(씬 전체가 한 키)에서 넘어오기", () => {
  const old: ScenesByProject = { acct: [scene("s1", "옛 배치의 씬"), scene("s2")], empty: [] };

  it("씬별 키로 풀고 옛 키를 지운다 — 버킷·순서·빈 버킷·세대·충돌 그대로", async () => {
    const conflict = { bucket: "acct", sceneId: "s1", mine: scene("s1"), theirs: scene("s1", "옛 창") };
    seedLegacyLayoutForTest(old, { generation: "g1", absorbBase: old, conflicts: [conflict] });
    const result = await initSceneStore(() => old, committed, keepMark);
    expect(result).toMatchObject({ kind: "ready", migrated: false }); // 옛 저장소에서 다시 이관한 것이 아니다
    expect(readScenesCache()).toEqual(old);
    expect(sceneStoreConflicts()).toHaveLength(1);
    const keys = sceneStoreKeysForTest();
    expect(keys).not.toContain("scenes");
    expect(keys).toContain("layout");
    expect(keys).toContain(JSON.stringify(["o", "empty"]));
  });

  // 풀고 난 뒤에는 옛 키가 없다. 그것을 'IndexedDB 가 사라졌다'로 읽으면 빈 상태로 열어 버린다.
  it("푼 뒤 다시 열어도 저장소가 사라진 것으로 오인하지 않는다", async () => {
    seedLegacyLayoutForTest(old, { generation: "g1" });
    await initSceneStore(() => ({}), committed, keepMark);
    rename("s1", "푼 뒤에 고침");
    await settleSceneStoreForTest();
    const again = await initSceneStore(() => ({}), committed, keepMark);
    expect(again.kind).toBe("ready");
    expect(names(readWorkingBucket("acct"))).toEqual(["푼 뒤에 고침", "s2"]);
  });

  it("푸는 도중 끊기면 옛 배치 그대로 남고, 다음에 열 때 다시 푼다", async () => {
    seedLegacyLayoutForTest(old, { generation: "g1" });
    abortSceneStoreWritesForTest(true);
    expect((await initSceneStore(() => ({}), committed, keepMark)).kind).toBe("failed");
    expect(sceneStoreKeysForTest()).toContain("scenes"); // 옛 키가 그대로다(반쯤 풀리지 않았다)
    expect(sceneStoreKeysForTest().some((key) => key.startsWith("["))).toBe(false);

    abortSceneStoreWritesForTest(false);
    expect((await initSceneStore(() => ({}), committed, keepMark)).kind).toBe("ready");
    expect(readScenesCache()).toEqual(old);
  });
});

// 평소 저장은 버전 숫자만 읽고 메모리의 확정본을 기준으로 쓴다. 그런데 연결이 끊긴 사이(사이트 데이터 삭제 등)
// 저장소가 지워지고 다른 창이 새로 만들면, 새 저장소의 버전 숫자가 우연히 같을 수 있다 — 그때 옛 확정본을 기준으로
// 쓰면 씬 키만 쓰고 순서 키는 안 써서, "확정됐다"고 알린 씬이 다른 창에는 없다(Codex 코드 리뷰 P1).
describe("연결이 끊긴 사이 저장소가 바뀌었다", () => {
  it("버전 숫자가 같아도 다시 읽는다 — 새 저장소에 없는 씬을 '확정'으로 알리지 않는다", async () => {
    await writeScenesStore({ acct: [scene("s1"), scene("s2")] }); // 이 창이 아는 저장소: 버전 1
    replaceSceneStoreForTest({}, 1); // 지워진 뒤 다른 창이 새로 초기화했다 — 비어 있고, 버전 숫자는 같다

    rename("s1", "사라진 씬을 고침");
    edit((all) => {
      all.acct = [...(all.acct || []), scene("s3", "새로 만든 씬")];
    });
    expect(await settleSceneStoreForTest()).toBe(true);

    // 저장소에는 '순서 없는 씬 키'가 남지 않는다 — 있는 것은 전부 순서에 올라 있다.
    const keys = sceneStoreKeysForTest();
    expect(keys).not.toContain(JSON.stringify(["s", "acct", "s1"]));
    expect(keys).toContain(JSON.stringify(["s", "acct", "s3"]));
    expect(keys).toContain(JSON.stringify(["o", "acct"]));
    // 이 창의 확정본·화면 값도 새 저장소를 따른다(없는 씬을 고친 연산은 할 일이 없다).
    expect(names(readConfirmedBucket("acct"))).toEqual(["새로 만든 씬"]);
    expect(names(readWorkingBucket("acct"))).toEqual(["새로 만든 씬"]);
  });

  // 초기화조차 안 된 저장소(지워진 직후)에 씬을 써 넣으면 다음 부팅이 '처음 이관인가·사라졌나'를 그르친다.
  it("알아보지 못하는 저장소에는 쓰지 않는다 — 저장 실패로 알리고 작업은 화면에 남는다", async () => {
    await writeScenesStore({ acct: [scene("s1")] });
    replaceSceneStoreForTest(null); // 통째로 지워졌다

    rename("s1", "지워진 뒤에 고침");
    expect(await settleSceneStoreForTest()).toBe(false);
    expect(sceneStoreKeysForTest()).toEqual([]); // 아무것도 쓰지 않았다
    expect(names(readWorkingBucket("acct"))).toEqual(["지워진 뒤에 고침"]); // 화면에는 그대로
    expect(sceneStoreHasPending()).toBe(true);
    // 내보내기는 그 빈 저장소가 아니라 화면 값을 준다 — 건질 것이 여기 있다.
    expect(names((await dumpSceneStore()).buckets.acct)).toEqual(["지워진 뒤에 고침"]);
  });
});

describe("옛 저장소(localStorage)의 이상한 모양", () => {
  // 씬별 키는 (버킷, 씬 id)로 자리를 정한다 — 그 둘이 없는 것은 담을 수 없다. 그런 항목 때문에 이관이 통째로
  // 실패하면 앱이 안 뜬다. 담을 수 있는 것만 옮기고 계속 간다(옛 저장소는 지우지 않으므로 사라지지는 않는다).
  it("배열이 아닌 버킷·id 없는 항목·같은 id 의 둘째는 빼고 옮긴다 — 이관은 실패하지 않는다", async () => {
    resetSceneStoreForTest();
    const legacy = {
      acct: [scene("s1"), null, { name: "id 없음" }, scene("s1", "같은 id 의 둘째"), scene("s2")],
      broken: "글자",
      alsoBroken: null,
    } as unknown as ScenesByProject;
    const result = await initSceneStore(() => legacy, null, keepMark);
    expect(result).toMatchObject({ kind: "ready", migrated: true });
    expect(readScenesCache()).toEqual({ acct: [scene("s1"), scene("s2")] });
  });
});
