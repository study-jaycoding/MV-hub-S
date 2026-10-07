// 씬 저장소의 쓰기 계약 — "화면 값은 그 자리에서, 확정은 뒤따라"(2026-10-07).
//
// 앱은 화면 값(working)만 읽고 쓴다. 쓰기는 '결과'가 아니라 **연산**으로 쌓이고, 확정할 때 저장소의 최신
// 내용 위에서 차례로 다시 실행된다. 그래서 ① 늦게 끝난 저장이 그사이의 새 편집을 덮지 않고 ② 다른 창이
// 그사이 한 변경을 덮지 않는다 — 쓰기를 Promise 로 기다리던 방식에서 리뷰마다 나오던 두 사고다.
// 진짜 IndexedDB 는 jsdom 에 없어 메모리 대체 경로로 돈다(실제 두 창은 frontend/measure 실측이 본다).
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applySceneOp,
  captureSceneOps,
  delaySceneStoreWritesForTest,
  failSceneStoreWritesForTest,
  hasWorkingBucket,
  readConfirmedBucket,
  readWorkingBucket,
  sceneStoreHasPending,
  settleSceneStoreForTest,
  subscribeSceneStoreExternal,
  writeSceneStoreAsOtherWindowForTest,
  writeScenesStore,
} from "../src/lib/sceneStore";
import type { Scene } from "../src/lib/scenes";

const scene = (id: string, name = id): Scene => ({ id, name, cards: [], edges: [], created_at: 1 });
const names = (list: Scene[]) => list.map((s) => s.name);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// 연산은 순수하다 — 입력은 밖에서 고정하고, 버킷은 새 배열로 갈아 끼운다.
const rename = (id: string, name: string) =>
  applySceneOp((all) => {
    all.acct = (all.acct || []).map((s) => (s.id === id ? { ...s, name } : s));
    return { write: true, value: null };
  });
const add = (s: Scene) =>
  applySceneOp((all) => {
    all.acct = [...(all.acct || []), s];
    return { write: true, value: null };
  });

// 화면이 "목록을 다시 읽어라"는 통지를 몇 번 받았나.
function watchExternal() {
  let count = 0;
  const off = subscribeSceneStoreExternal(() => {
    count += 1;
  });
  return { off, get count() { return count; } };
}

describe("씬 저장소 — 화면 값과 확정", () => {
  afterEach(() => {
    failSceneStoreWritesForTest(false);
    delaySceneStoreWritesForTest(0);
  });

  it("쓰기는 그 자리에서 화면 값에 보이고, 확정본에는 확정된 뒤에 보인다", async () => {
    add(scene("s1"));
    expect(names(readWorkingBucket("acct"))).toEqual(["s1"]);
    expect(readConfirmedBucket("acct")).toEqual([]);
    expect(sceneStoreHasPending()).toBe(true); // '저장 안 됨' 표시의 근거

    expect(await settleSceneStoreForTest()).toBe(true);
    expect(names(readConfirmedBucket("acct"))).toEqual(["s1"]);
    expect(sceneStoreHasPending()).toBe(false);
  });

  it("읽은 목록을 제자리에서 고쳐도 저장소는 움직이지 않는다", async () => {
    await writeScenesStore({ acct: [scene("s1")] });
    readWorkingBucket("acct")[0].name = "밖에서 고침";
    readConfirmedBucket("acct")[0].name = "밖에서 고침";
    expect(names(readWorkingBucket("acct"))).toEqual(["s1"]);
    expect(names(readConfirmedBucket("acct"))).toEqual(["s1"]);
  });

  // 종전(쓰기를 Promise 로 기다리던 방식)의 사고: 늦게 끝난 저장의 응답이 그사이의 새 편집을 덮었다.
  it("느린 저장이 끝나도 그사이에 한 새 편집을 덮지 않는다", async () => {
    await writeScenesStore({ acct: [scene("s1", "처음")] });
    delaySceneStoreWritesForTest(20);
    rename("s1", "첫 편집");
    await sleep(5); // 첫 저장이 가는 중에
    rename("s1", "둘째 편집");
    await sleep(30); // 첫 저장이 끝났다
    expect(names(readWorkingBucket("acct"))).toEqual(["둘째 편집"]); // 화면은 최신 그대로

    delaySceneStoreWritesForTest(0);
    expect(await settleSceneStoreForTest()).toBe(true);
    expect(names(readConfirmedBucket("acct"))).toEqual(["둘째 편집"]);
  });

  // 종전 localStorage 는 버킷 전체를 덮어, 두 창이 같이 떠 있으면 늦게 쓴 쪽이 다른 쪽의 씬을 지웠다.
  it("다른 창이 그사이 바꾼 내용 위에서 내 연산이 다시 실행된다 — 둘 다 남는다", async () => {
    await writeScenesStore({ acct: [scene("s1"), scene("s2")] });
    const external = watchExternal();
    try {
      writeSceneStoreAsOtherWindowForTest((all) => {
        all.acct = [...all.acct, scene("other", "다른 창이 만든 씬")];
      });
      rename("s1", "내가 바꾼 이름");
      expect(names(readWorkingBucket("acct"))).toEqual(["내가 바꾼 이름", "s2"]); // 아직 다른 창 것을 모른다

      expect(await settleSceneStoreForTest()).toBe(true);
      const merged = ["내가 바꾼 이름", "s2", "다른 창이 만든 씬"];
      expect(names(readConfirmedBucket("acct"))).toEqual(merged);
      expect(names(readWorkingBucket("acct"))).toEqual(merged); // 화면 값도 따라온다
      expect(external.count).toBe(1); // 화면이 목록을 다시 읽게 알린다
    } finally {
      external.off();
    }
  });

  it("내 편집만 확정됐으면 화면에 다시 읽으라고 알리지 않는다", async () => {
    await writeScenesStore({ acct: [scene("s1")] });
    const external = watchExternal();
    try {
      rename("s1", "내 편집");
      expect(await settleSceneStoreForTest()).toBe(true);
      expect(external.count).toBe(0); // 알리면 캔버스가 방금 친 내용을 저장본으로 갈아 끼운다
    } finally {
      external.off();
    }
  });

  // 내구성이 필요한 흐름(생성 제출 전 표식 등)은 '큐가 비었나'가 아니라 그 작업의 연산만 기다린다.
  it("작업의 확정은 그 작업의 연산만 본다 — 실패하면 false, 다시 받으면 그 연산도 확정된다", async () => {
    await writeScenesStore({ acct: [scene("s1")] });
    failSceneStoreWritesForTest(true);
    const marked = captureSceneOps(() => rename("s1", "표식"));
    expect(marked.value.ok).toBe(true); // 화면 값에는 들어갔다
    expect(await marked.confirmed).toBe(false); // 이번 시도에는 확정 못 했다
    expect(names(readConfirmedBucket("acct"))).toEqual(["s1"]);

    failSceneStoreWritesForTest(false);
    const next = captureSceneOps(() => add(scene("s2")));
    expect(await next.confirmed).toBe(true);
    expect(names(readConfirmedBucket("acct"))).toEqual(["표식", "s2"]); // 밀려 있던 것도 순서대로
  });

  it("연산을 내지 않은 작업은 기다릴 것이 없다", async () => {
    const idle = captureSceneOps(() => "값");
    expect(idle.value).toBe("값");
    expect(await idle.confirmed).toBe(true);
  });

  // 화면에서는 됐는데 저장소 내용 위에서는 못 하는 연산은 버린다 — 단, 조용히 버리지 않는다:
  // 그 작업에는 실패로 알리고, 화면 값에서도 걷어내 저장소에 없는 편집을 계속 보여 주지 않는다.
  it("재생에서 던진 연산은 버리고 화면 값에서도 걷어낸다 — 다른 연산은 확정된다", async () => {
    await writeScenesStore({ acct: [scene("s1")] });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const external = watchExternal();
    try {
      let runs = 0; // 시험용 — 화면 값에는 적용되고 재생에서만 던지게 한다
      const bad = captureSceneOps(() =>
        applySceneOp((all) => {
          runs += 1;
          if (runs > 1) throw new Error("replay fails");
          all.acct = all.acct.map((s) => ({ ...s, name: "버려질 편집" }));
          return { write: true, value: null };
        }),
      );
      const good = captureSceneOps(() => add(scene("s2")));
      expect(names(readWorkingBucket("acct"))).toEqual(["버려질 편집", "s2"]);

      expect(await bad.confirmed).toBe(false);
      expect(await good.confirmed).toBe(true);
      expect(names(readConfirmedBucket("acct"))).toEqual(["s1", "s2"]);
      expect(names(readWorkingBucket("acct"))).toEqual(["s1", "s2"]);
      expect(external.count).toBe(1);
      expect(sceneStoreHasPending()).toBe(false);
      expect(errors).toHaveBeenCalled();
    } finally {
      external.off();
      errors.mockRestore();
    }
  });

  // 계정 귀속처럼 '먼저 보이면 안 되는' 변경 — 다른 창이 먼저 확정했을 수 있다.
  it("확정 전용 연산은 확정된 뒤에만 화면 값에 보인다", async () => {
    await writeScenesStore({ _none: [scene("old")] });
    const external = watchExternal();
    try {
      applySceneOp(
        (all) => {
          if (!all._none) return { write: false, value: null };
          all.acct = [...(all.acct || []), ...all._none];
          delete all._none;
          return { write: true, value: null };
        },
        { confirmedOnly: true },
      );
      expect(readWorkingBucket("acct")).toEqual([]);
      expect(hasWorkingBucket("_none")).toBe(true);

      expect(await settleSceneStoreForTest()).toBe(true);
      expect(names(readWorkingBucket("acct"))).toEqual(["old"]);
      expect(hasWorkingBucket("_none")).toBe(false);
      expect(external.count).toBe(1); // 확정되면 화면이 목록을 다시 읽는다
    } finally {
      external.off();
    }
  });

});

// 저장소가 오래 막히면 연산이 쌓인다(연산마다 그때의 입력을 들고 있다 — 캔버스 편집이면 카드 배열 한 벌).
describe("씬 저장소 — 오래 막혔을 때", () => {
  const PENDING_MAX = 200; // sceneStore 의 상한
  afterEach(() => {
    failSceneStoreWritesForTest(false);
    delaySceneStoreWritesForTest(0);
  });

  // 같은 씬을 고치는 연산(scenes.updateScene 이 내는 모양) — 뒤 입력이 같은 필드를 덮는다.
  const patchScene = (id: string, fields: Partial<Scene>) => {
    const apply = (all: Record<string, Scene[]>, patch: Partial<Scene>) => {
      all.acct = (all.acct || []).map((s) => (s.id === id ? { ...s, ...patch } : s));
    };
    return applySceneOp(
      (all) => {
        apply(all, fields);
        return { write: true, value: null };
      },
      { merge: { slot: `update:${id}`, patch: fields, join: (a, b) => ({ ...a, ...b }), replay: apply } },
    );
  };

  it("같은 씬을 계속 고치면 밀린 연산이 하나로 합쳐져 쌓이지 않는다 — 내용은 차례로 한 것과 같다", async () => {
    await writeScenesStore({ acct: [scene("s1"), scene("s2")] });
    failSceneStoreWritesForTest(true);
    patchScene("s1", { camera: { x: 1, y: 1, z: 1 } });
    for (let i = 0; i < PENDING_MAX * 3; i += 1) expect(patchScene("s1", { name: `편집 ${i}` }).ok).toBe(true);
    expect(await settleSceneStoreForTest()).toBe(false);
    for (let i = 0; i < PENDING_MAX * 3; i += 1) expect(patchScene("s1", { name: `다시 ${i}` }).ok).toBe(true); // 실패 뒤에도 합친다
    expect(add(scene("s3")).ok).toBe(true); // 상한에 닿지 않았다

    failSceneStoreWritesForTest(false);
    expect(await settleSceneStoreForTest()).toBe(true);
    const saved = readConfirmedBucket("acct");
    expect(names(saved)).toEqual([`다시 ${PENDING_MAX * 3 - 1}`, "s2", "s3"]);
    expect(saved[0].camera).toEqual({ x: 1, y: 1, z: 1 }); // 앞선 입력의 다른 필드는 살아 있다
    expect(saved).toEqual(readWorkingBucket("acct"));
  });

  it("사이에 다른 연산이 끼면 합치지 않는다 — 순서가 바뀌면 결과가 달라진다", async () => {
    await writeScenesStore({ acct: [scene("s1")] });
    patchScene("s1", { name: "먼저" });
    applySceneOp((all) => {
      all.acct = all.acct.map((s) => ({ ...s, name: `${s.name}+사이` })); // 앞 편집의 결과를 읽는 연산
      return { write: true, value: null };
    });
    patchScene("s1", { camera: { x: 2, y: 2, z: 2 } });
    expect(await settleSceneStoreForTest()).toBe(true);
    expect(readConfirmedBucket("acct")[0]).toMatchObject({ name: "먼저+사이", camera: { x: 2, y: 2, z: 2 } });
  });

  it("이미 저장으로 떠난 연산에는 합치지 않는다 — 떠난 뒤에 온 입력을 잃지 않는다", async () => {
    await writeScenesStore({ acct: [scene("s1")] });
    delaySceneStoreWritesForTest(20);
    patchScene("s1", { name: "첫 편집" });
    await sleep(5); // 첫 편집이 저장으로 떠난 뒤에
    patchScene("s1", { name: "둘째 편집" });
    await sleep(30); // 첫 저장이 끝났다 — 둘째는 아직
    expect(names(readWorkingBucket("acct"))).toEqual(["둘째 편집"]);
    expect(sceneStoreHasPending()).toBe(true);
    delaySceneStoreWritesForTest(0);
    expect(await settleSceneStoreForTest()).toBe(true);
    expect(names(readConfirmedBucket("acct"))).toEqual(["둘째 편집"]);
  });

  // ★쌓인 연산을 '지금 내 버킷 통째'로 뭉쳐 줄이면, 재생될 때 그사이 다른 창이 확정한 변경을 지운다
  //  (Codex 코드 리뷰 P1). 그래서 줄이지 않고, 상한에서 새 연산을 받지 않는다 — 받은 것은 하나도 잃지 않는다.
  it("상한에 닿으면 새 연산을 거절한다 — 받은 연산과 다른 창의 변경은 모두 남는다", async () => {
    await writeScenesStore({ acct: [scene("s1")] });
    failSceneStoreWritesForTest(true);
    for (let i = 0; i < PENDING_MAX - 1; i += 1) expect(add(scene(`mine${i}`)).ok).toBe(true);
    // 상한의 마지막 한 자리를 쓰는 작업 — 그 확정을 기다리는 쪽이 영영 매달리면 안 된다(같은 리뷰의 P1).
    const lastIn = captureSceneOps(() => add(scene("last-in")));
    expect(lastIn.value.ok).toBe(true);

    const refused = captureSceneOps(() => add(scene("too-many")));
    expect(refused.value.ok).toBe(false); // 받지 않았다고 알린다
    expect(await refused.confirmed).toBe(false);
    expect(names(readWorkingBucket("acct"))).not.toContain("too-many"); // 화면 값에도 넣지 않았다
    expect(await settleSceneStoreForTest()).toBe(false); // 막힌 채로 한 번 시도했다

    writeSceneStoreAsOtherWindowForTest((all) => {
      all.acct = [...all.acct, scene("other", "다른 창이 그사이 만든 씬")];
    });
    failSceneStoreWritesForTest(false);
    expect(await settleSceneStoreForTest()).toBe(true);
    expect(await lastIn.confirmed).toBe(false); // 처음 시도는 실패로 알렸고(그 뒤 다시 시도돼 확정됐다)
    const saved = names(readConfirmedBucket("acct"));
    expect(saved).toHaveLength(1 + PENDING_MAX + 1);
    expect(saved).toContain("다른 창이 그사이 만든 씬");
    expect(saved).toContain("last-in");
    expect(add(scene("after")).ok).toBe(true); // 풀리면 다시 받는다
  });

  it("상한에 닿아 있어도, 밀린 연산이 확정되면 그것을 기다리던 작업은 끝난다", async () => {
    await writeScenesStore({ acct: [scene("s1")] });
    delaySceneStoreWritesForTest(15); // 느릴 뿐 실패하지는 않는다
    for (let i = 0; i < PENDING_MAX - 1; i += 1) add(scene(`mine${i}`));
    const lastIn = captureSceneOps(() => add(scene("last-in")));
    expect(add(scene("too-many")).ok).toBe(false);
    expect(await lastIn.confirmed).toBe(true); // 매달리지 않는다
    expect(names(readConfirmedBucket("acct"))).toContain("last-in");
  });
});
