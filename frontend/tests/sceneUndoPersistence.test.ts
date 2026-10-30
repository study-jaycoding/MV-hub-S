// @vitest-environment jsdom
// 되돌리기 기록을 새로 고쳐도 남게(docs/status/캔버스_한계_B_되돌리기보존_2026-10-30.md, 설계 §9.5·§9.9) — 페이지 로드별 슬롯·탭별 포인터·
// 삭제 세대·용량·부팅 복원과 창 인계의 채택 규칙. 페이지 로드(새로 고침·복제 탭)는 vi.resetModules 로 흉내 낸다 — writerId 가 새로 생기고,
// sessionStorage(포인터)와 가짜 칸(jsdom 에 IndexedDB 가 없어 같은 판정 planUndoPut 을 쓰는 메모리 칸)은 남는다.
import { act, createElement, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UndoBackend, UndoSlot } from "../src/lib/sceneUndoPersistence";
import type { SceneCard } from "../src/lib/scenes";

type Persist = typeof import("../src/lib/sceneUndoPersistence");
type Undo = typeof import("../src/lib/sceneUndoStore");
type Boot = typeof import("../src/lib/sceneBoot");

const POINTERS = "mvhub.undoPointers";
const BUCKET = "local::_none";
const card = (id: string, x = 0) => ({ id, kind: "text", x, y: 0 });
const snap = (...cards: object[]) => ({ cards, edges: [], groups: [] }) as never;
const scene = (cards: object[], extra: object = {}) => ({ id: "s1", name: "s1", created_at: 1, edges: [], cards, ...extra });
// 저장된 씬 = 편집 뒤 모습(lastCommit). 그 앞 모습 하나가 undo 에 있다.
const AFTER = [card("c1", 50)];
const history = () => ({ undo: [snap(card("c1", 0))], redo: [], lastCommit: snap(...AFTER) });

function fakeBackend(plan: Persist["planUndoPut"], nextGeneration: Persist["nextDeleteGeneration"]) {
  const slots = new Map<string, UndoSlot>();
  const gens = new Map<string, number>();
  const puts: UndoSlot[] = [];
  let total = 0;
  const gk = (account: string, sceneId: string) => `${account}|${sceneId}`;
  const backend: UndoBackend = {
    async put(slot, budget) {
      const previous = slots.get(slot.key);
      const decided = plan({ generation: gens.get(gk(slot.account, slot.sceneId)) ?? 0, total, previousSize: previous?.size ?? 0 }, slot, budget);
      if (decided.result === "ok") {
        slots.set(slot.key, structuredClone(slot));
        total = decided.total;
        puts.push(slot);
      }
      return decided.result;
    },
    async get(key) { return slots.has(key) ? structuredClone(slots.get(key)!) : null; },
    async generation(account, sceneId) { return gens.get(gk(account, sceneId)) ?? 0; },
    async generations(account) {
      return Object.fromEntries([...gens].filter(([key]) => key.startsWith(`${account}|`)).map(([key, value]) => [key.slice(account.length + 1), value]));
    },
    async forget(account, sceneId, generation) {
      const next = nextGeneration(gens.get(gk(account, sceneId)) ?? 0, generation);
      gens.set(gk(account, sceneId), next);
      for (const [key, slot] of slots) if (slot.account === account && slot.sceneId === sceneId) { total -= slot.size; slots.delete(key); }
      return next;
    },
    async prune(before) {
      for (const [key, slot] of slots) if (slot.savedAt < before) { total -= slot.size; slots.delete(key); }
    },
  };
  return { slots, gens, puts, backend, total: () => total };
}

let fake: ReturnType<typeof fakeBackend>;
async function pageLoad(cards: object[] = AFTER, extra: object = {}): Promise<{ persist: Persist; undo: Undo; boot: Boot }> {
  vi.resetModules();
  const persist = await import("../src/lib/sceneUndoPersistence");
  fake ??= fakeBackend(persist.planUndoPut, persist.nextDeleteGeneration);
  persist.setUndoBackend(fake.backend);
  const { initSceneStore } = await import("../src/lib/sceneStore");
  let mark: Parameters<typeof initSceneStore>[1] = null;
  await initSceneStore(() => ({ [BUCKET]: [scene(cards, extra)] as never }), mark, (next) => { mark = next; return true; });
  return { persist, undo: await import("../src/lib/sceneUndoStore"), boot: await import("../src/lib/sceneBoot") };
}
const pointers = () => JSON.parse(sessionStorage.getItem(POINTERS) || "{}") as Record<string, string>;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
async function until(check: () => boolean) {
  for (let waited = 0; !check(); waited += 5) {
    if (waited > 2000) throw new Error("기다린 값이 오지 않았다");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
function deferred() {
  let resolve!: (ok: boolean) => void;
  const confirmed = new Promise<boolean>((done) => { resolve = done; });
  return { receipt: { confirmed }, resolve };
}
const OK = { confirmed: Promise.resolve(true) };

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  fake = undefined as never;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("슬롯에 쓰고 새로 고친 뒤 들인다", () => {
  it("그 저장이 확정되면 자기 슬롯에 쓰고 포인터를 옮긴다 → 새로 고친 뒤 부팅 복원이 그 기록을 들인다", async () => {
    const first = await pageLoad();
    first.persist.scheduleUndoCheckpoint("s1", history(), 1, OK);
    await until(() => fake.puts.length === 1);
    expect(Object.values(pointers())).toEqual([fake.puts[0].key]);

    const second = await pageLoad();
    await second.boot.restoreUndoHistories();
    expect(second.undo.loadSceneHistory("s1")).toEqual(history());
  });

  it("영수증이 확정되지 않았거나·지문이 저장본과 다르거나·빈 기록이면 쓰지 않는다", async () => {
    const { persist } = await pageLoad();
    persist.scheduleUndoCheckpoint("s1", history(), 1, { confirmed: Promise.resolve(false) });
    persist.scheduleUndoCheckpoint("s2", history(), 1, OK); // 그런 씬이 저장돼 있지 않다
    await settle();
    persist.scheduleUndoCheckpoint("s1", { ...history(), lastCommit: snap(card("c1", 999)) }, 1, OK); // 그 뒤 편집이 또 저장됐다
    persist.scheduleUndoCheckpoint("s1", { undo: [], redo: [], lastCommit: snap(...AFTER) }, 0, OK); // 부팅 직후의 빈 기록
    await settle();
    await settle();
    expect(fake.puts).toEqual([]);
    expect(pointers()).toEqual({});
  });

  it("진행 하나·최신 대기 하나 — 진행 중에 낸 예약은 마지막 것만 쓰고, 예약 뒤 스택이 바뀌어도 예약 때 모습을 쓴다", async () => {
    const { persist } = await pageLoad();
    const first = deferred();
    const h = history();
    persist.scheduleUndoCheckpoint("s1", h, 1, first.receipt);
    h.undo.push(snap(card("c1", 25))); // 예약 뒤 그 자리에서 바뀐 스택
    persist.scheduleUndoCheckpoint("s1", history(), 2, OK);
    persist.scheduleUndoCheckpoint("s1", history(), 3, OK);
    first.resolve(true);
    await until(() => fake.puts.length === 2);
    await settle();
    expect(fake.puts.map((slot) => slot.historyRevision)).toEqual([1, 3]);
    expect(fake.puts[0].history.undo).toHaveLength(1);
    expect(fake.slots.size).toBe(1); // 같은 로드의 쓰기는 한 슬롯을 덮는다
  });
});

describe("복제 탭·보존·용량", () => {
  it("복제 탭은 원본 슬롯을 읽어 들이고, 그 뒤 쓰기는 자기 슬롯에 — 원본 슬롯은 그대로다", async () => {
    const original = await pageLoad();
    original.persist.scheduleUndoCheckpoint("s1", history(), 1, OK);
    await until(() => fake.puts.length === 1);
    const originalKey = fake.puts[0].key;

    const duplicate = await pageLoad(); // sessionStorage(포인터)가 복사된 새 로드
    await duplicate.boot.restoreUndoHistories();
    expect(duplicate.undo.loadSceneHistory("s1")).toEqual(history());
    const longer = { ...history(), undo: [snap(card("c1", -10)), snap(card("c1", 0))] };
    duplicate.persist.scheduleUndoCheckpoint("s1", longer, 1, OK);
    await until(() => fake.puts.length === 2);
    await settle();
    expect(fake.puts[1].key).not.toBe(originalKey);
    expect(fake.slots.get(originalKey)?.history.undo).toHaveLength(1);
    expect(Object.values(pointers())).toEqual([fake.puts[1].key]);
  });

  it("보존은 마지막 저장부터 7일 — 지난 슬롯은 들이지 않고 정리한다", async () => {
    const first = await pageLoad();
    first.persist.scheduleUndoCheckpoint("s1", history(), 1, OK);
    await until(() => fake.puts.length === 1);
    const key = fake.puts[0].key;
    fake.slots.get(key)!.savedAt = Date.now() - first.persist.UNDO_KEEP_MS + 60_000; // 7일이 아직 안 됐다
    let next = await pageLoad();
    await next.boot.restoreUndoHistories();
    expect(next.undo.loadSceneHistory("s1")).toEqual(history());
    fake.slots.get(key)!.savedAt = Date.now() - first.persist.UNDO_KEEP_MS - 60_000;
    next = await pageLoad();
    await next.boot.restoreUndoHistories();
    expect(next.undo.loadSceneHistory("s1")).toBeUndefined();
    await until(() => !fake.slots.has(key));
  });

  it("용량은 교체 후 합계로 본다 — 넘는 쓰기는 실패하고 기존 것을 지키며, 상한에 닿아도 같거나 작은 갱신은 받는다", async () => {
    const { persist } = await pageLoad();
    const slot = (size: number) => ({ deleteGeneration: 0, size });
    expect(persist.planUndoPut({ generation: 0, total: 90, previousSize: 40 }, slot(50), 100)).toEqual({ result: "ok", total: 100 });
    expect(persist.planUndoPut({ generation: 0, total: 90, previousSize: 40 }, slot(51), 100)).toEqual({ result: "full", total: 90 });
    expect(persist.planUndoPut({ generation: 0, total: 130, previousSize: 40 }, slot(40), 100)).toEqual({ result: "ok", total: 130 });
    expect(persist.planUndoPut({ generation: 1, total: 0, previousSize: 0 }, slot(1), 100)).toEqual({ result: "deleted", total: 0 });
    // 공유 객체는 한 번만 센다(같은 카드가 undo·lastCommit 에 함께 있다)
    const shared = snap(card("c1"));
    expect(persist.logicalSize({ undo: [shared], redo: [], lastCommit: shared }))
      .toBeLessThan(persist.logicalSize({ undo: [snap(card("c1"))], redo: [], lastCommit: snap(card("c1")) }));
  });
});

describe("삭제·포인터·실패", () => {
  it("씬을 지우면 늦게 확정된 쓰기를 버리고 포인터도 옮기지 않는다 — 있던 슬롯도 지운다", async () => {
    const { persist, undo } = await pageLoad();
    persist.scheduleUndoCheckpoint("s1", history(), 1, OK);
    await until(() => fake.puts.length === 1);
    const late = deferred();
    persist.scheduleUndoCheckpoint("s1", { ...history(), undo: [] , redo: [snap(card("c1", 0))] }, 2, late.receipt);
    undo.clearSceneHistory("s1"); // 씬 삭제(useSceneCoordination)
    late.resolve(true);
    await settle();
    await settle();
    expect(fake.puts).toHaveLength(1);
    expect(fake.slots.size).toBe(0);
    expect(pointers()).toEqual({});
  });

  it("포인터를 못 쓰면 이전 포인터를 두고, 다음 성공 저장 때 다시 게시한다", async () => {
    const { persist } = await pageLoad();
    const setItem = Storage.prototype.setItem;
    let block = true;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === POINTERS && block) throw new DOMException("quota", "QuotaExceededError");
      return setItem.call(this, key, value);
    });
    persist.scheduleUndoCheckpoint("s1", history(), 1, OK);
    await until(() => fake.puts.length === 1);
    await settle();
    expect(pointers()).toEqual({});
    block = false;
    persist.scheduleUndoCheckpoint("s1", history(), 2, OK);
    await until(() => fake.puts.length === 2);
    await until(() => Object.keys(pointers()).length === 1);
    expect(Object.values(pointers())).toEqual([fake.puts[1].key]);
  });

  it("쓰기가 커밋된 뒤 다른 창이 그 씬을 지웠으면 늦은 완료가 포인터를 게시하지 않는다(리뷰 2차 P2)", async () => {
    const { persist } = await pageLoad();
    const real = fake.backend;
    persist.setUndoBackend({ ...real, put: async (slot, budget) => {
      const result = await real.put(slot, budget);
      await real.forget("local", "s1", 1); // 커밋 직후 다른 창의 삭제가 커밋됐다
      return result;
    } });
    persist.scheduleUndoCheckpoint("s1", history(), 1, OK);
    await until(() => fake.puts.length === 1);
    await settle();
    await settle();
    expect(pointers()).toEqual({});
  });

  it("칸을 못 열거나 읽기가 멈춰도 부팅한다 — 기다리는 시간을 넘으면 기록 없이 띄운다", async () => {
    const { persist, undo, boot } = await pageLoad();
    sessionStorage.setItem(POINTERS, JSON.stringify({ [JSON.stringify(["local", "s1"])]: "x" }));
    persist.setUndoBackend({ ...fake.backend, get: () => Promise.reject(new Error("blocked")) });
    await boot.restoreUndoHistories();
    persist.setUndoBackend({ ...fake.backend, get: () => new Promise(() => {}) });
    const started = Date.now();
    await boot.restoreUndoHistories(50);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(undo.loadSceneHistory("s1")).toBeUndefined();
  });

  it("전에 지운 적 있는 씬을 세대를 모르는 다른 창이 지워도 세대가 반드시 올라가, 삭제 전에 예약한 쓰기를 막는다(리뷰 P1)", async () => {
    const { persist, boot } = await pageLoad();
    fake.gens.set("local|s1", 1); // 지웠다 되살린 씬
    await boot.restoreUndoHistories(); // 이 창은 세대 1 을 안다
    const late = deferred();
    persist.scheduleUndoCheckpoint("s1", history(), 1, late.receipt); // 세대 1 로 예약
    expect(await fake.backend.forget("local", "s1", 1)).toBe(2); // 세대를 모르던(0) 다른 창의 삭제 — 1 을 넘겨도 2 로
    late.resolve(true);
    await settle();
    await settle();
    expect(fake.puts).toEqual([]);
    expect(persist.nextDeleteGeneration(5, 1)).toBe(6);
    expect(persist.nextDeleteGeneration(0, 3)).toBe(3);
  });

  it("지웠다 되살린 씬을 포인터 없는 새 탭에서 처음 고쳐도 그 기록이 남는다 — 부팅 때 세대를 읽어 둔다(리뷰 P2)", async () => {
    let tab = await pageLoad();
    fake.gens.set("local|s1", 1);
    await tab.boot.restoreUndoHistories();
    tab.persist.scheduleUndoCheckpoint("s1", history(), 1, OK);
    await until(() => fake.puts.length === 1);
    expect(fake.puts[0].deleteGeneration).toBe(1);
    tab = await pageLoad();
    await tab.boot.restoreUndoHistories();
    expect(tab.undo.loadSceneHistory("s1")).toEqual(history());
  });

  it("예약 뒤 기록 안쪽(카드)이 그 자리에서 바뀌어도 예약 때 모습을 쓴다(리뷰 P2)", async () => {
    const { persist } = await pageLoad();
    const h = history();
    const later = deferred();
    persist.scheduleUndoCheckpoint("s1", h, 1, later.receipt);
    (h.undo[0] as { cards: { x: number }[] }).cards[0].x = 999;
    later.resolve(true);
    await until(() => fake.puts.length === 1);
    expect((fake.puts[0].history.undo[0] as { cards: { x: number }[] }).cards[0].x).toBe(0);
  });

  it("다른 계정의 슬롯은 들이지 않는다", async () => {
    const first = await pageLoad();
    first.persist.scheduleUndoCheckpoint("s1", history(), 1, OK);
    await until(() => fake.puts.length === 1);
    sessionStorage.setItem("ch.accountScope", "bob"); // 이 탭의 계정이 바뀌었다(앱은 바꾸면 새로 고친다)
    const next = await pageLoad();
    await next.boot.restoreUndoHistories();
    expect(next.undo.loadSceneHistory("s1")).toBeUndefined();
  });
});

describe("들이는 규칙 — 부팅 복원과 창 인계(adoptSceneHistory)", () => {
  const target = { account: "local", sceneId: "s1", snapFp: null };
  const candidate = (undo: Undo, h = history()) => ({ account: "local", sceneId: "s1", snapFp: undo.snapFingerprint(h.lastCommit), history: h });
  const boot = (undo: Undo, expectedLocalRevision = 0) => ({ kind: "bootstrap" as const, readEpoch: undo.historyReadEpoch(), expectedLocalRevision });
  const handoff = (undo: Undo) => ({ kind: "handoff" as const, handoffId: null, expectedLocalRevision: undo.localSceneRevision("s1") });

  it("인계로 받은 씬은 늦게 끝난 부팅 복원이 덮지 않는다(역순 도착) — 부팅 복원 뒤의 인계는 바꾼다", async () => {
    let { undo } = await pageLoad();
    const fromHandoff = { ...history(), redo: [snap(card("c1", 7))] };
    const gate = boot(undo);
    expect(undo.adoptSceneHistory(target, candidate(undo, fromHandoff), handoff(undo))).toBe("adopted");
    expect(undo.adoptSceneHistory(target, candidate(undo), gate)).toBe("stale");
    expect(undo.loadSceneHistory("s1")).toEqual(fromHandoff);

    ({ undo } = await pageLoad());
    expect(undo.adoptSceneHistory(target, candidate(undo), boot(undo))).toBe("adopted");
    expect(undo.adoptSceneHistory(target, candidate(undo, fromHandoff), handoff(undo))).toBe("adopted");
    expect(undo.takeSceneHistory("s1", snap(...AFTER))).toEqual(fromHandoff); // 보드가 열릴 때 지금 씬과 맞는 인계로 바꾼다
  });

  it("읽기·인계를 시작한 뒤 이 창에서 편집했으면 받지 않는다 — 인계 번호가 다르면 받지 않는다", async () => {
    const { undo } = await pageLoad();
    const gate = boot(undo);
    undo.noteLocalSceneEdit("s1");
    expect(undo.adoptSceneHistory(target, candidate(undo), gate)).toBe("stale");
    expect(undo.adoptSceneHistory(target, candidate(undo), { ...handoff(undo), expectedLocalRevision: 0 })).toBe("stale");
    expect(undo.adoptSceneHistory(target, candidate(undo), { ...handoff(undo), handoffId: "other-window" })).toBe("stale");
    expect(undo.adoptSceneHistory(target, { ...candidate(undo), account: "acct:bob" }, handoff(undo))).toBe("mismatch");
    expect(undo.loadSceneHistory("s1")).toBeUndefined();
  });

  it("보드 없이 받은 인계가 저장본과 다르면 확인 전이라 부팅 복원이 바꾸고, 저장본과 같으면 인계가 우선이다(리뷰 P2)", async () => {
    let { undo, persist } = await pageLoad();
    const saved = { ...target, snapFp: persist.savedSceneFingerprint("s1") };
    const old = { undo: [snap(card("c1", -5))], redo: [], lastCommit: snap(card("c1", -1)) }; // 저장본과 다른(낡은) 인계
    expect(undo.adoptSceneHistory(target, candidate(undo, old), handoff(undo))).toBe("adopted");
    expect(undo.adoptSceneHistory(saved, candidate(undo), boot(undo))).toBe("adopted");
    expect(undo.loadSceneHistory("s1")).toEqual(history());

    ({ undo, persist } = await pageLoad());
    const fresh = { ...history(), redo: [snap(card("c1", 7))] }; // 저장본과 같은 인계
    expect(undo.adoptSceneHistory(target, candidate(undo, fresh), handoff(undo))).toBe("adopted");
    expect(undo.adoptSceneHistory({ ...target, snapFp: persist.savedSceneFingerprint("s1") }, candidate(undo), boot(undo))).toBe("stale");
    expect(undo.loadSceneHistory("s1")).toEqual(fresh);
  });

  it("부팅 복원 뒤 보드 없이 온 낡은 인계는 그 기록을 덮지 않고, 보드가 열릴 때 지금 씬과 맞는 쪽을 쓴다(리뷰 2차 P2)", async () => {
    const { undo, persist } = await pageLoad();
    expect(undo.adoptSceneHistory({ ...target, snapFp: persist.savedSceneFingerprint("s1") }, candidate(undo), boot(undo))).toBe("adopted");
    const stale = { undo: [snap(card("c1", -5))], redo: [], lastCommit: snap(card("c1", -1)) };
    undo.adoptSceneHistory(target, candidate(undo, stale), handoff(undo));
    expect(undo.loadSceneHistory("s1")).toEqual(history());
    expect(undo.takeSceneHistory("s1", snap(...AFTER))).toEqual(history());
    const fresh = { ...history(), redo: [snap(card("c1", 9))] }; // 지금 씬과 맞는 인계는 보드가 열릴 때 그것을 쓴다(더 새 창의 기록)
    undo.adoptSceneHistory(target, candidate(undo, fresh), handoff(undo));
    expect(undo.takeSceneHistory("s1", snap(...AFTER))).toEqual(fresh);
  });

  it("인계 중에 이 창이 씬을 지웠으면(같은 id 로 되살려도) 그 뒤 돌아온 삭제 전 인계를 받지 않는다(리뷰 2차 P1)", async () => {
    const { undo } = await pageLoad();
    const popup = await import("../src/lib/popupWindows");
    popup.shareCanvasMemory();
    vi.spyOn(window, "open").mockImplementation((() => ({ closed: false, focus: vi.fn(), addEventListener: vi.fn() })) as never);
    popup.openEmbedWindow(popup.EMBED_MODES.canvas);
    undo.clearSceneHistory("s1"); // 삭제(그 뒤 같은 id 로 되살렸다고 치자 — 저장본은 그대로)
    const port = (window as unknown as Record<string, { load: (memory: object) => void }>).__mvhubCanvasMemory;
    port.load({ sceneHistories: { account: "local", handoffId: popup.canvasHandoffId(), entries: [["s1", history()]] } });
    expect(undo.loadSceneHistory("s1")).toBeUndefined();
    expect(undo.takeSceneHistory("s1", snap(...AFTER))).toBeUndefined();
    await settle();
    expect(fake.puts).toEqual([]);
  });

  it("빈 기록 인계·옛 판 배열 인계는 받지 않는다 — 빈 인계 뒤의 정상 복원이 막히지 않는다(리뷰 P1·P2)", async () => {
    const { undo, persist } = await pageLoad();
    const popup = await import("../src/lib/popupWindows");
    popup.shareCanvasMemory();
    const port = (window as unknown as Record<string, { load: (memory: object) => void }>).__mvhubCanvasMemory;
    port.load({ sceneHistories: [["s1", history()]] }); // 옛 판 배열 — 보낸 계정·인계를 알 수 없다
    expect(undo.loadSceneHistory("s1")).toBeUndefined();
    port.load({ sceneHistories: { account: "local", handoffId: popup.canvasHandoffId(), entries: [["s1", { undo: [], redo: [], lastCommit: snap(...AFTER) }]] } });
    expect(undo.loadSceneHistory("s1")).toBeUndefined();
    expect(undo.adoptSceneHistory({ ...target, snapFp: persist.savedSceneFingerprint("s1") }, candidate(undo), boot(undo))).toBe("adopted");
  });

  it("열린 보드가 편집 전 빈 기록이면 늦은 복원이 그 보드의 스택을 바꾸고, 보드의 모습과 지문이 다르면 받지 않는다", async () => {
    const { undo } = await pageLoad();
    const adopted: unknown[] = [];
    let shown = snap(...AFTER);
    undo.registerLiveSceneHistory({
      sceneId: () => "s1",
      flush: () => undo.saveSceneHistory("s1", { undo: [], redo: [], lastCommit: shown }),
      adopt: (h) => { adopted.push(h); return true; },
    });
    expect(undo.adoptSceneHistory(target, candidate(undo), boot(undo))).toBe("adopted");
    expect(adopted).toEqual([history()]);
    shown = snap(card("c1", 999));
    expect(undo.adoptSceneHistory(target, candidate(undo), handoff(undo))).toBe("mismatch");
    expect(adopted).toHaveLength(1);
  });

  it("창 인계 — 연 창이 편집하지 않았으면 돌려받은 기록으로 바꾸고, 그 창의 슬롯에 남긴다(돌려받은 뒤 새로 고쳐도 이어지게)", async () => {
    const { undo } = await pageLoad();
    const popup = await import("../src/lib/popupWindows");
    popup.shareCanvasMemory();
    vi.spyOn(window, "open").mockImplementation((() => ({ closed: false, focus: vi.fn(), addEventListener: vi.fn() })) as never);
    popup.openEmbedWindow(popup.EMBED_MODES.canvas); // 인계 시작 — 번호를 정하고 지금 편집 횟수를 기준으로 잡는다
    const id = popup.canvasHandoffId();
    expect(id).toBeTruthy();
    const port = (window as unknown as Record<string, { load: (memory: object) => void }>).__mvhubCanvasMemory;
    port.load({ sceneHistories: { account: "local", handoffId: id, entries: [["s1", history()]] } });
    expect(undo.loadSceneHistory("s1")).toEqual(history());
    await until(() => fake.puts.length === 1); // 인계 기록은 지문 대조만으로 이 창의 슬롯에

    undo.noteLocalSceneEdit("s1"); // 그 뒤 이 창에서 편집했다 — 다음 돌려받기는 받지 않는다
    port.load({ sceneHistories: { account: "local", handoffId: id, entries: [["s1", { ...history(), redo: [snap(card("c1", 3))] }]] } });
    expect(undo.loadSceneHistory("s1")).toEqual(history());
  });
});

describe("보드에서 — useSceneHistory + 실제 씬 저장 영수증(writeSceneSnapshot)", () => {
  async function mountBoard(cards: object[], extra: object = {}) {
    const loaded = await pageLoad(cards, extra);
    const scenes = await import("../src/lib/scenes");
    const { useSceneHistory } = await import("../src/lib/useSceneHistory");
    await loaded.boot.restoreUndoHistories();
    const saved = scenes.listPersistedScenes(null)[0];
    const initial = { cards: saved.cards, edges: saved.edges, groups: saved.groups || [] };
    let api!: ReturnType<typeof useSceneHistory>;
    let view!: { ref: { current: SceneCard[] }; set: (cards: SceneCard[]) => void };
    function Probe() {
      const [, setCards] = useState(initial.cards);
      const cardsRef = useRef(initial.cards);
      view = { ref: cardsRef, set: setCards };
      api = useSceneHistory({
        sceneId: "s1", initialSnapshot: initial, sceneIdRef: useRef("s1"), cardsRef, edgesRef: useRef(initial.edges), groupsRef: useRef(initial.groups),
        setCards, setEdges: () => {}, setGroups: () => {}, clearSelection: () => {}, frozenRef: useRef(false),
        onChange: (snapshot) => scenes.writeSceneSnapshot({ accountNamespace: "local", sceneId: "s1" }, snapshot),
      });
      return null;
    }
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const root = createRoot(document.createElement("div"));
    act(() => root.render(createElement(Probe)));
    const show = (next: object[]) => { view.ref.current = next as SceneCard[]; view.set(next as SceneCard[]); };
    return {
      scenes,
      edit: (next: object[]) => act(() => { show(next); api.persist(next as SceneCard[], initial.edges, initial.groups); }),
      show: (next: object[]) => act(() => show(next)), // 화면에만(실행 중 표식처럼 저장하지 않는 값)
      undo: () => act(() => api.undo()),
      redo: () => act(() => api.redo()),
      cards: () => view.ref.current,
      unmount: () => act(() => root.unmount()),
    };
  }

  it("편집·Undo 뒤 새로 고쳐도 Ctrl+Z·다시 하기가 이어진다", async () => {
    const first = await mountBoard([card("c1", 0)]);
    first.edit([card("c1", 50)]);
    first.edit([card("c1", 100)]);
    first.undo(); // 50 으로 — 되돌린 단계는 다시 하기에 있다
    await until(() => fake.puts.at(-1)?.history.redo.length === 1);
    await settle();
    const saved = first.scenes.listPersistedScenes(null)[0].cards;
    expect(saved).toEqual([card("c1", 50)]);
    first.unmount();

    const second = await mountBoard(saved); // 새로 고침 — 저장본은 50
    second.undo();
    expect(second.cards()).toEqual([card("c1", 0)]);
    second.redo();
    second.redo();
    expect(second.cards()).toEqual([card("c1", 100)]);
    second.unmount();
  });

  it("실행 중 Ctrl+Z 는 실행 표식을 되돌리지 않고(화면은 생성중 그대로, 저장은 완료/대기만) 씬의 실행 목록도 건드리지 않는다", async () => {
    const run = { version: 1, originHubId: "h", originDeviceId: "d", attemptId: "a1", runGroupId: "g1", groupSeq: 1, copyIndex: 0,
      cardId: "k", configFp: "c", inputFp: "i", localState: "submitted" };
    const extra = { comfyRuns: [run], comfyCardRuns: { k: { groupId: "g1", groupSeq: 1 } } };
    const comfy = (x: number, cfg: object = {}) => ({ id: "k", kind: "comfy", x, y: 0, comfyCfg: { content: "{}", ...cfg } });
    const board = await mountBoard([comfy(0)], extra);
    board.edit([comfy(50)]);
    board.show([comfy(50, { status: "running", runId: 7 })]); // 실행 시작 — 화면 표식
    board.undo();
    expect(board.cards()).toEqual([comfy(0, { status: "running", runId: 7 })]);
    await until(() => board.scenes.listPersistedScenes(null)[0].cards[0].x === 0);
    const saved = board.scenes.listPersistedScenes(null)[0];
    expect(saved.cards[0].comfyCfg?.status).not.toBe("running");
    expect(saved.comfyRuns).toEqual([run]);
    expect(saved.comfyCardRuns).toEqual(extra.comfyCardRuns);
    board.unmount();
  });
});
