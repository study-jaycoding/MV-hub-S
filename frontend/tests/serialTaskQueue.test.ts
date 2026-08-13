import { describe, expect, it } from "vitest";
import { SerialTaskQueue } from "../src/lib/serialTaskQueue";

describe("순차 작업 대기열", () => {
  it("여러 작업을 받은 순서대로 하나씩 실행하고 실패 후에도 계속한다", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const order: string[] = [];
    const errors: string[] = [];
    let running = 0;
    let maxRunning = 0;
    let started = false;
    let resolveIdle!: () => void;
    const idle = new Promise<void>((resolve) => {
      resolveIdle = resolve;
    });

    const queue = new SerialTaskQueue<number>(
      async (item) => {
        started = true;
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        order.push(`start:${item}`);
        try {
          if (item === 1) await firstGate;
          if (item === 2) throw new Error("second failed");
          order.push(`done:${item}`);
        } finally {
          running -= 1;
        }
      },
      (state) => {
        if (started && state.total === 0) resolveIdle();
      },
      (error) => errors.push(error instanceof Error ? error.message : String(error)),
    );

    queue.enqueue(1);
    queue.enqueue(2);
    queue.enqueue(3);

    await Promise.resolve();
    expect(order).toEqual(["start:1"]);
    expect(queue.snapshot()).toEqual({ active: true, queued: 2, total: 3 });

    releaseFirst();
    await idle;

    expect(maxRunning).toBe(1);
    expect(order).toEqual(["start:1", "done:1", "start:2", "start:3", "done:3"]);
    expect(errors).toEqual(["second failed"]);
    expect(queue.snapshot()).toEqual({ active: false, queued: 0, total: 0 });
  });
});
