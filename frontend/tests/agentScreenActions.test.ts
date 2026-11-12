// @vitest-environment jsdom
// MV Agent 화면 동작 실행기(docs/status/MVAgent_화면동작_2026-11-12.md 3-2·3-3·3-3b) — 진짜 캔버스 편집 규칙(applyCanvasEdit)을 쓰는
//  가짜 보드 손잡이로 명령 전후 비교·되돌리기 조건을 본다. 회색은 진짜 저장(localStorage)으로.
import { beforeEach, describe, expect, it } from "vitest";
import type { CanvasInputCommand } from "../src/features/canvas/api";
import { applyCanvasEdit, type CanvasEditCommand, type CanvasSnapshot } from "../src/features/canvas/edits";
import { runScreenAction, sceneFingerprint, undoScreenAction, type SceneScreenHandle, type ScreenHost } from "../src/lib/agentScreenActions";
import { disabledGenRev, loadDisabledGen, saveDisabledGen } from "../src/lib/deactivated";
import { STORAGE_KEYS } from "../src/lib/storageKeys";

function fakeBoard(sceneId = "s1", initial?: Partial<CanvasSnapshot>) {
  let doc: CanvasSnapshot = { cards: [], edges: [], groups: [], ...initial };
  let editable = true;
  let selected: string[] = [];
  const commits: CanvasInputCommand[] = [];
  const handle: SceneScreenHandle = {
    sceneId,
    commit: (command) => {
      commits.push(command);
      if (!editable) return false;
      const next = applyCanvasEdit(doc, command as CanvasEditCommand, {});
      if (!next) return false;
      doc = next.snapshot;
      return true;
    },
    snapshot: () => doc,
    viewCenter: () => ({ x: 500, y: 300 }),
    canEdit: () => editable,
    selectCards: (ids) => { selected = ids; },
    selectedCardIds: () => selected,
  };
  return {
    handle, commits,
    host: { scene: () => handle } as ScreenHost,
    setEditable: (value: boolean) => { editable = value; },
    select: (ids: string[]) => { selected = ids; },
    selected: () => selected,
    doc: () => doc,
    edit: (command: CanvasEditCommand) => { doc = applyCanvasEdit(doc, command, {})!.snapshot; },
  };
}

beforeEach(() => localStorage.clear());

describe("MV Agent 화면 동작 실행기", () => {
  it("모르는 이름·다른 씬·이 창에 보드 없음은 실행하지 않는다", () => {
    const board = fakeBoard();
    expect(runScreenAction("library.delete", {}, board.host)).toMatchObject({ ok: false, summary: "모르는 화면 동작이에요" });
    expect(runScreenAction("canvas.create_nodes", { scene_id: "other", nodes: [{ kind: "text" }] }, board.host).ok).toBe(false);
    expect(runScreenAction("canvas.read_selection", { scene_id: "s1" }, { scene: () => null }).summary).toBe("그 씬을 이 창의 캔버스에서 열어 주세요");
    expect(board.commits).toEqual([]);
  });

  it("보기 모드면 거절(바뀐 것 없음과 가름) · 고른 카드 읽기는 보기 모드에서도", () => {
    const board = fakeBoard("s1", { cards: [{ id: "a", kind: "text", x: 0, y: 0, text: "  달이 뜬\n 밤  " }] });
    board.setEditable(false);
    expect(runScreenAction("canvas.create_nodes", { scene_id: "s1", nodes: [{ kind: "text" }] }, board.host).summary).toBe("보기 모드라 바꿀 수 없어요");
    board.select(["a", "gone"]);
    expect(runScreenAction("canvas.read_selection", { scene_id: "s1" }, board.host).data).toEqual({ cards: [{ id: "a", kind: "text", label: "달이 뜬 밤" }] });
  });

  it("노드 만들기 — 명령 하나에 글까지(되돌리기 한 칸) · 실제로 생긴 것만 보고 · 만든 노드를 고름 · 화면 가운데부터 옆으로", () => {
    const board = fakeBoard();
    const got = runScreenAction("canvas.create_nodes", { scene_id: "s1", nodes: [{ kind: "generation" }, { kind: "text", text: "제목" }, { kind: "list" }] }, board.host);
    expect(got.ok).toBe(true);
    expect(got.summary).toBe("새 노드 2개 만듦"); // 허용 밖 종류는 만들지 않는다
    const ids = got.data.card_ids as string[];
    expect(board.doc().cards.map((c) => [c.id, c.kind, c.text])).toEqual([[ids[0], "generation", undefined], [ids[1], "text", "제목"]]);
    expect(board.commits.filter((c) => c.type === "editNodeText")).toEqual([]); // 글은 따로 저장하지 않는다
    expect(board.selected()).toEqual(ids);
    expect(board.doc().cards.map((c) => c.x)).toEqual([410, 630]);
  });

  it("잇기 — 명시한 쌍만, 안 되는 쌍은 건너뜀, 새 엣지만 보고", () => {
    const board = fakeBoard("s1", { cards: [
      { id: "t", kind: "text", x: 0, y: 0, text: "글" },
      { id: "g", kind: "generation", x: 300, y: 0, status: "empty", refs: [], genId: null },
    ] });
    const got = runScreenAction("canvas.connect", { scene_id: "s1", pairs: [["t", "g"], ["g", "nope"], ["x"]] }, board.host);
    expect(got.ok).toBe(true);
    expect(got.summary).toBe("1개 이음 · 1개 건너뜀");
    expect(got.data.skipped).toEqual([["g", "nope"]]);
    expect(board.doc().edges.map((e) => [e.from, e.to])).toEqual([["t", "g"]]);
    expect(runScreenAction("canvas.connect", { scene_id: "s1", pairs: [["t", "g"]] }, board.host)).toMatchObject({ ok: false, summary: "이을 수 있는 쌍이 없었어요" });
  });

  it("되돌리기 — 지문이 같을 때만 · 뒤에 사람이 손대면 거절 · 만들기 → 잇기 → 잇기 되돌리기 → 만들기 되돌리기", () => {
    const board = fakeBoard("s1", { cards: [{ id: "t", kind: "text", x: 0, y: 0, text: "글" }] });
    const made = runScreenAction("canvas.create_nodes", { scene_id: "s1", nodes: [{ kind: "generation" }] }, board.host);
    const gen = (made.data.card_ids as string[])[0];
    const joined = runScreenAction("canvas.connect", { scene_id: "s1", pairs: [["t", gen]] }, board.host);
    const later = [joined.undo!.kind === "canvas" ? joined.undo!.fingerprint : ""];
    expect(undoScreenAction(made.undo!, board.host, later)).toEqual({ ok: false, message: "아래 카드부터 되돌려 주세요" });
    expect(undoScreenAction(joined.undo!, board.host)).toEqual({ ok: true, message: "되돌렸어요" });
    expect(board.doc().edges).toEqual([]);
    // 잇기를 되돌린 뒤엔 앞 동작 직후 지문과 다시 같다(엣지 순서·참조 갱신까지 내용이 같아야 함)
    expect(sceneFingerprint(board.doc())).toBe(made.undo!.kind === "canvas" ? made.undo!.fingerprint : "");
    expect(undoScreenAction(made.undo!, board.host)).toEqual({ ok: true, message: "되돌렸어요" });
    expect(board.doc().cards.map((c) => c.id)).toEqual(["t"]);
    // 사람이 뒤에 손댄 경우
    const again = runScreenAction("canvas.create_nodes", { scene_id: "s1", nodes: [{ kind: "text", text: "a" }] }, board.host);
    board.edit({ type: "editNodeText", cardId: (again.data.card_ids as string[])[0], text: "사람이 고침" });
    expect(undoScreenAction(again.undo!, board.host)).toEqual({ ok: false, message: "그 뒤 캔버스가 바뀌어 되돌릴 수 없어요 — Ctrl+Z 를 쓰세요" });
    expect(board.doc().cards).toHaveLength(2);
  });

  it("회색(비활성) — 목표 상태로 · 다시 읽어 실제로 바뀐 것만 · 이 브라우저 기준 · 되돌리기는 그 뒤 다른 회색 변경이 없을 때만", () => {
    saveDisabledGen(new Set(["g1"]));
    const board = fakeBoard();
    const got = runScreenAction("library.set_hidden", { generation_ids: ["g1", "g2", 7], hidden: true }, board.host);
    expect(got).toMatchObject({ ok: true, summary: "생성물 1개 회색(비활성)으로 바꿈 · 이 브라우저 기준", data: { changed: ["g2"] } });
    expect([...loadDisabledGen()].sort()).toEqual(["g1", "g2"]);
    expect(undoScreenAction(got.undo!, board.host)).toEqual({ ok: true, message: "되돌렸어요" });
    expect([...loadDisabledGen()]).toEqual(["g1"]); // 원래 회색이던 g1 은 그대로
    // 뒤에 사람이 회색을 바꾸면 되돌리지 않는다
    const next = runScreenAction("library.set_hidden", { generation_ids: ["g3"], hidden: true }, board.host);
    saveDisabledGen(new Set([...loadDisabledGen(), "g9"]));
    expect(undoScreenAction(next.undo!, board.host).ok).toBe(false);
  });

  it("다른 창의 회색 변경 — storage 알림에 바뀜 번호가 오르고, 알림이 늦어도 저장된 값이 다르면 되돌리지 않는다", () => {
    const board = fakeBoard();
    const got = runScreenAction("library.set_hidden", { generation_ids: ["g1"], hidden: true }, board.host);
    const rev = disabledGenRev();
    window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEYS.historyDisabled }));
    expect(disabledGenRev()).toBe(rev + 1);
    expect(undoScreenAction(got.undo!, board.host).ok).toBe(false);
    // 알림이 아직 안 온 다른 창의 저장(값만 바뀜)
    const second = runScreenAction("library.set_hidden", { generation_ids: ["g5"], hidden: true }, board.host);
    localStorage.setItem(STORAGE_KEYS.historyDisabled, JSON.stringify(["g1", "g5", "other-window"]));
    expect(undoScreenAction(second.undo!, board.host)).toEqual({ ok: false, message: "그 뒤 회색 표시가 바뀌어 되돌릴 수 없어요" });
  });

  it("다른 창이 풀었다 다시 회색으로 해 값이 같아지고 알림이 늦어도 — 저장마다 새로 적는 표식으로 거절(독립 리뷰 P1)", () => {
    const board = fakeBoard();
    const got = runScreenAction("library.set_hidden", { generation_ids: ["g1"], hidden: true }, board.host);
    const stored = localStorage.getItem(STORAGE_KEYS.historyDisabled);
    // 다른 창: 풀기 → 다시 회색(같은 값). 그 창도 저장할 때 표식을 새로 적는다 — 알림은 아직 안 옴
    localStorage.setItem(`${STORAGE_KEYS.historyDisabled}.stamp`, JSON.stringify("other-window-1"));
    localStorage.setItem(`${STORAGE_KEYS.historyDisabled}.stamp`, JSON.stringify("other-window-2"));
    expect(localStorage.getItem(STORAGE_KEYS.historyDisabled)).toBe(stored);
    expect(undoScreenAction(got.undo!, board.host).ok).toBe(false);
  });

  it("표식은 값보다 먼저 쓰고, 표식 쓰기가 실패하면 지운다 — 값만 같은 다른 창 저장도 되돌리기를 막는다(독립 리뷰 2차 P1)", () => {
    const board = fakeBoard();
    const got = runScreenAction("library.set_hidden", { generation_ids: ["g1"], hidden: true }, board.host);
    const order: string[] = [];
    const real = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      order.push(key);
      if (key.endsWith(".stamp")) throw new Error("quota"); // 표식만 못 씀
      return real.call(this, key, value);
    };
    try {
      saveDisabledGen(new Set(loadDisabledGen())); // 같은 값을 다시 씀(다른 창의 '풀기 → 다시 회색' 끝 모습)
    } finally {
      Storage.prototype.setItem = real;
    }
    expect(order).toEqual([`${STORAGE_KEYS.historyDisabled}.stamp`, STORAGE_KEYS.historyDisabled]);
    expect(localStorage.getItem(`${STORAGE_KEYS.historyDisabled}.stamp`)).toBeNull(); // 지워져 빈 표식
    window.dispatchEvent(new StorageEvent("storage", { key: "unrelated" })); // 번호는 그대로인 경우(알림 없음)를 흉내 — 이 창 저장이라 번호는 올랐다
    expect(undoScreenAction(got.undo!, board.host).ok).toBe(false);
  });

  it("빈 표식은 자격이 아니다 — 동작 때 표식을 못 쓰면 되돌리기 없음 · 다른 창이 표식을 지우고 값만 같게 돌려도 거절(독립 리뷰 3차 P1)", () => {
    const board = fakeBoard();
    const STAMP = `${STORAGE_KEYS.historyDisabled}.stamp`;
    const real = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key === STAMP) throw new Error("quota");
      return real.call(this, key, value);
    };
    let blind: ReturnType<typeof runScreenAction>;
    try {
      blind = runScreenAction("library.set_hidden", { generation_ids: ["g2"], hidden: true }, board.host);
    } finally {
      Storage.prototype.setItem = real;
    }
    expect([blind.ok, blind.undo]).toEqual([true, undefined]); // 회색은 바뀌었지만 되돌리기 단추는 없다
    const got = runScreenAction("library.set_hidden", { generation_ids: ["g3"], hidden: true }, board.host);
    localStorage.removeItem(STAMP); // 다른 창: 표식 저장 실패로 지움 + 값은 같게(알림 늦음)
    expect(undoScreenAction(got.undo!, board.host)).toEqual({ ok: false, message: "그 뒤 회색 표시가 바뀌어 되돌릴 수 없어요" });
  });

  it("되돌리기 저장 직후 다른 창이 덮어쓰거나, 내 저장 실패와 다른 창 저장이 겹치면 기준을 새로 잡지 않는다(독립 리뷰 3차 P1)", () => {
    const board = fakeBoard();
    const KEY = STORAGE_KEYS.historyDisabled;
    const STAMP = `${KEY}.stamp`;
    const real = Storage.prototype.setItem;
    const got = runScreenAction("library.set_hidden", { generation_ids: ["g4"], hidden: true }, board.host);
    Storage.prototype.setItem = function (key: string, value: string) {
      real.call(this, key, value);
      if (key === KEY) { // 내 저장 바로 뒤 다른 창이 다시 회색으로
        real.call(this, STAMP, JSON.stringify("other-window"));
        real.call(this, KEY, JSON.stringify(["g4"]));
      }
    };
    let overwritten: ReturnType<typeof undoScreenAction>;
    try {
      overwritten = undoScreenAction(got.undo!, board.host);
    } finally {
      Storage.prototype.setItem = real;
    }
    expect(overwritten).toEqual({ ok: false, message: "그 뒤 회색 표시가 바뀌어 되돌릴 수 없어요" }); // 그 사람의 회색을 기준으로 삼지 않는다
    const next = runScreenAction("library.set_hidden", { generation_ids: ["g5"], hidden: true }, board.host);
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key === KEY) { real.call(this, STAMP, JSON.stringify("other-window-2")); throw new Error("quota"); } // 내 값은 실패, 그 사이 다른 창 표식
      return real.call(this, key, value);
    };
    let mixed: ReturnType<typeof undoScreenAction>;
    try {
      mixed = undoScreenAction(next.undo!, board.host);
    } finally {
      Storage.prototype.setItem = real;
    }
    expect(mixed).toEqual({ ok: false, message: "그 뒤 회색 표시가 바뀌어 되돌릴 수 없어요" });
  });

  it("되돌리기 저장이 실패한 뒤 저장이 풀리면 같은 카드로 다시 되돌릴 수 있다(독립 리뷰 2차 P2)", () => {
    const board = fakeBoard();
    const hidden = runScreenAction("library.set_hidden", { generation_ids: ["g8"], hidden: true }, board.host);
    const real = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key === STORAGE_KEYS.historyDisabled) throw new Error("quota");
      return real.call(this, key, value);
    };
    let first: ReturnType<typeof undoScreenAction>;
    try {
      first = undoScreenAction(hidden.undo!, board.host);
    } finally {
      Storage.prototype.setItem = real;
    }
    expect([first.ok, !!first.undo]).toEqual([false, true]);
    expect(undoScreenAction(first.undo!, board.host)).toEqual({ ok: true, message: "되돌렸어요" });
    expect([...loadDisabledGen()]).not.toContain("g8");
  });

  it("되돌리기는 실제로 되돌려졌을 때만 성공 — 캔버스가 거절하거나 회색 저장이 실패하면 단추를 남긴다(독립 리뷰 P2)", () => {
    const board = fakeBoard();
    const made = runScreenAction("canvas.create_nodes", { scene_id: "s1", nodes: [{ kind: "generation" }] }, board.host);
    const refuse = { ...board.host.scene()!, commit: () => false };
    expect(undoScreenAction(made.undo!, { scene: () => refuse })).toEqual({ ok: false, message: "되돌리지 못했어요 — 캔버스가 받아들이지 않았어요" });
    expect(board.doc().cards).toHaveLength(1);
    const hidden = runScreenAction("library.set_hidden", { generation_ids: ["g7"], hidden: true }, board.host);
    const real = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key === STORAGE_KEYS.historyDisabled) throw new Error("quota");
      return real.call(this, key, value);
    };
    try {
      expect(undoScreenAction(hidden.undo!, board.host)).toMatchObject({ ok: false, message: "되돌리지 못했어요 — 저장이 안 됐어요" });
    } finally {
      Storage.prototype.setItem = real;
    }
    expect([...loadDisabledGen()]).toContain("g7");
  });
});
