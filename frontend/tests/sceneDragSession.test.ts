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
});
