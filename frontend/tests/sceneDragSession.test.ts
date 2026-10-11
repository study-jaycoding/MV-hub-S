import { describe, expect, it } from "vitest";
import {
  createSceneDragSession,
  type SceneDragEventType,
  type SceneDragListener,
} from "../src/lib/sceneDragSession";

type DragEvent = { id: string };

function harness() {
  const listeners = new Map<SceneDragEventType, Set<SceneDragListener<DragEvent>>>();
  const frames = new Map<number, () => void>();
  let nextFrameId = 1;

  const session = createSceneDragSession<DragEvent>({
    addListener: (type, listener) => {
      let bucket = listeners.get(type);
      if (!bucket) listeners.set(type, (bucket = new Set()));
      bucket.add(listener);
    },
    removeListener: (type, listener) => listeners.get(type)?.delete(listener),
    requestFrame: (callback) => {
      const id = nextFrameId++;
      frames.set(id, callback);
      return id;
    },
    cancelFrame: (id) => frames.delete(id),
  });

  return {
    session,
    emit(type: SceneDragEventType, event: DragEvent = { id: type }) {
      for (const listener of [...(listeners.get(type) || [])]) listener(event);
    },
    flushFrames() {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((callback) => callback());
    },
    listenerCount() {
      return [...listeners.values()].reduce((sum, bucket) => sum + bucket.size, 0);
    },
    frameCount() {
      return frames.size;
    },
  };
}

describe("createSceneDragSession", () => {
  it("한 프레임 안의 mousemove는 마지막 좌표만 반영한다", () => {
    const h = harness();
    const moved: string[] = [];
    h.session.begin((event) => moved.push(event.id), () => undefined);

    h.emit("mousemove", { id: "first" });
    h.emit("mousemove", { id: "last" });
    expect(moved).toEqual([]);
    expect(h.frameCount()).toBe(1);

    h.flushFrames();
    expect(moved).toEqual(["last"]);
  });

  it("mouseup은 예약된 마지막 이동을 먼저 반영한 뒤 정상 완료한다", () => {
    const h = harness();
    const order: string[] = [];
    h.session.begin(
      (event) => order.push(`move:${event.id}`),
      (event) => order.push(`up:${event.id}`),
    );

    h.emit("mousemove", { id: "pending" });
    h.emit("mouseup", { id: "released" });

    expect(order).toEqual(["move:pending", "up:released"]);
    expect(h.listenerCount()).toBe(0);
    expect(h.frameCount()).toBe(0);
  });

  it("blur은 마지막 이동을 반영하고 정상 완료 대신 취소 콜백만 실행한다", () => {
    const h = harness();
    const order: string[] = [];
    h.session.begin(
      (event) => order.push(`move:${event.id}`),
      () => order.push("up"),
      () => order.push("cancel"),
    );

    h.emit("mousemove", { id: "pending" });
    h.emit("blur");
    h.emit("mouseup", { id: "late" });

    expect(order).toEqual(["move:pending", "cancel"]);
    expect(h.listenerCount()).toBe(0);
  });

  it("새 드래그는 끝나지 않은 이전 드래그를 먼저 취소한다", () => {
    const h = harness();
    const order: string[] = [];
    h.session.begin(
      (event) => order.push(`first-move:${event.id}`),
      () => order.push("first-up"),
      () => order.push("first-cancel"),
    );
    h.emit("mousemove", { id: "pending" });

    h.session.begin(
      () => order.push("second-move"),
      () => order.push("second-up"),
    );
    h.emit("mouseup");

    expect(order).toEqual(["first-move:pending", "first-cancel", "second-up"]);
  });

  it("settle 은 남은 끌기를 blur 처럼 끝낸다 — 밀린 걸음을 반영하고 취소 콜백. 그 뒤의 begin 은 앞 끌기를 다시 건드리지 않는다", () => {
    const h = harness();
    const order: string[] = [];
    h.session.begin(
      (event) => order.push(`first-move:${event.id}`),
      () => order.push("first-up"),
      () => order.push("first-cancel"),
    );
    h.emit("mousemove", { id: "pending" });

    h.session.settle(); // 새 누름의 첫머리 — 새 조작이 시작 좌표를 읽기 전
    expect(order).toEqual(["first-move:pending", "first-cancel"]);
    expect(h.listenerCount()).toBe(0);
    expect(h.frameCount()).toBe(0);

    order.push("read-start"); // 새 조작이 시작 좌표를 읽는다
    h.session.begin(() => order.push("second-move"), () => order.push("second-up"));
    h.emit("mouseup");
    expect(order).toEqual(["first-move:pending", "first-cancel", "read-start", "second-up"]);
  });

  it("settle 은 남은 끌기가 없으면 아무 일도 하지 않는다 — 정상으로 끝난 뒤·시작 전", () => {
    const h = harness();
    const order: string[] = [];
    h.session.settle();
    h.session.begin(() => order.push("move"), () => order.push("up"), () => order.push("cancel"));
    h.emit("mouseup");
    h.session.settle();
    expect(order).toEqual(["up"]);
  });

  it("rebase 는 도는 끌기의 onRebase 만 부른다 — 밀린 걸음은 건드리지 않고(이벤트를 다시 넣지 않는다), 끝난 끌기·onRebase 없는 끌기에는 아무 일도 없다", () => {
    const h = harness();
    const order: string[] = [];
    h.session.rebase(); // 끌기가 없다
    h.session.begin(
      (event) => order.push(`move:${event.id}`),
      () => order.push("up"),
      () => order.push("cancel"),
      () => order.push("rebase"),
    );
    h.emit("mousemove", { id: "pending" });
    h.session.rebase();
    expect(order).toEqual(["rebase"]); // 밀린 걸음은 그대로 프레임을 기다린다
    expect(h.frameCount()).toBe(1);
    h.flushFrames();
    h.emit("mouseup");
    expect(order).toEqual(["rebase", "move:pending", "up"]);
    h.session.rebase(); // 끝난 뒤
    expect(order).toEqual(["rebase", "move:pending", "up"]);

    // 새 끌기는 앞 끌기의 onRebase 를 물려받지 않는다 — 버린(dispose) 끌기의 것도 남지 않는다
    h.session.begin(() => undefined, () => undefined, undefined, () => order.push("old-rebase"));
    h.session.dispose();
    h.session.rebase();
    h.session.begin(() => undefined, () => undefined, undefined, () => order.push("first-rebase"));
    h.session.begin(() => undefined, () => order.push("second-up"));
    h.session.rebase();
    expect(order).toEqual(["rebase", "move:pending", "up"]);
  });

  it("dispose는 이동·취소 콜백 없이 예약 프레임과 리스너만 제거한다", () => {
    const h = harness();
    const order: string[] = [];
    h.session.begin(
      () => order.push("move"),
      () => order.push("up"),
      () => order.push("cancel"),
    );
    h.emit("mousemove", { id: "pending" });

    h.session.dispose();
    h.flushFrames();

    expect(order).toEqual([]);
    expect(h.listenerCount()).toBe(0);
    expect(h.frameCount()).toBe(0);
  });

  it("dispose 뒤에도 같은 세션으로 새 끌기를 시작할 수 있다(씬 전환의 abort 뒤, Codex)", () => {
    const h = harness();
    const order: string[] = [];
    h.session.begin(() => order.push("old-move"), () => order.push("old-up"));
    h.emit("mousemove", { id: "pending" });
    h.session.dispose();

    h.session.begin((event) => order.push(`new-move:${event.id}`), () => order.push("new-up"));
    h.emit("mousemove", { id: "next" });
    h.flushFrames();
    h.emit("mouseup");

    expect(order).toEqual(["new-move:next", "new-up"]);
    expect(h.listenerCount()).toBe(0);
  });
});
