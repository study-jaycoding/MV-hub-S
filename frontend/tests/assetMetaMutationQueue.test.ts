import { describe, expect, it, vi } from "vitest";
import { createLatestMutationQueue, createMutationQueue } from "../src/lib/mutationQueue";

describe("asset meta mutation queue", () => {
  it("executes rapid mutations in input order", async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const queue = createMutationQueue(vi.fn());

    const first = queue.enqueue(async () => {
      events.push("first:start");
      await firstGate;
      events.push("first:end");
    });
    const second = queue.enqueue(async () => {
      events.push("second");
    });

    await Promise.resolve();
    expect(events).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second"]);
  });

  it("reconciles once after all queued mutations when an earlier save fails", async () => {
    const reconcile = vi.fn(async () => undefined);
    const queue = createMutationQueue(reconcile);
    const events: string[] = [];

    const first = queue.enqueue(async () => {
      events.push("failed");
      throw new Error("save failed");
    });
    const second = queue.enqueue(async () => {
      events.push("second");
    });

    await Promise.all([first, second]);
    expect(events).toEqual(["failed", "second"]);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile.mock.calls[0][0]).toEqual([expect.any(Error)]);
  });

  it("continues accepting mutations after reconcile itself fails", async () => {
    const reconcile = vi.fn().mockRejectedValueOnce(new Error("reload failed"));
    const queue = createMutationQueue(reconcile);
    const later = vi.fn(async () => undefined);

    await queue.enqueue(async () => {
      throw new Error("save failed");
    });
    await queue.enqueue(later);

    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(later).toHaveBeenCalledTimes(1);
  });

  it("keeps a mutation queued while failure reconciliation is running", async () => {
    const events: string[] = [];
    let releaseReconcile!: () => void;
    const reconcileGate = new Promise<void>((resolve) => {
      releaseReconcile = resolve;
    });
    const queue = createMutationQueue(async () => {
      events.push("reconcile:start");
      await reconcileGate;
      events.push("reconcile:end");
    });

    const failed = queue.enqueue(async () => {
      throw new Error("save failed");
    });
    await vi.waitFor(() => expect(events).toEqual(["reconcile:start"]));
    const later = queue.enqueue(async () => {
      events.push("later");
    });

    await Promise.resolve();
    expect(events).toEqual(["reconcile:start"]);
    releaseReconcile();
    await Promise.all([failed, later]);
    expect(events).toEqual(["reconcile:start", "reconcile:end", "later"]);
  });

  it("연속 저장이 모두 성공하면 마지막에 한 번만 성공 동기화한다", async () => {
    const reconcileSuccess = vi.fn(async () => undefined);
    const queue = createMutationQueue(vi.fn(), reconcileSuccess);

    const first = queue.enqueue(async () => undefined);
    const second = queue.enqueue(async () => undefined);
    await Promise.all([first, second]);

    expect(reconcileSuccess).toHaveBeenCalledTimes(1);
  });

  it("저장 실패가 있으면 성공 동기화 대신 실패 복구만 실행한다", async () => {
    const reconcileFailure = vi.fn(async () => undefined);
    const reconcileSuccess = vi.fn(async () => undefined);
    const queue = createMutationQueue(reconcileFailure, reconcileSuccess);

    await queue.enqueue(async () => {
      throw new Error("save failed");
    });

    expect(reconcileFailure).toHaveBeenCalledTimes(1);
    expect(reconcileSuccess).not.toHaveBeenCalled();
  });
});

describe("latest mutation queue", () => {
  it("keeps the running mutation and replaces queued intermediate snapshots", async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const queue = createLatestMutationQueue(vi.fn());

    queue.enqueue(async () => {
      events.push("first:start");
      await firstGate;
      events.push("first:end");
    });
    queue.enqueue(async () => {
      events.push("intermediate");
    });
    queue.enqueue(async () => {
      events.push("latest");
    });

    releaseFirst();
    await queue.whenIdle();
    expect(events).toEqual(["first:start", "first:end", "latest"]);
  });

  it("does not reconcile an old failure when the latest snapshot succeeds", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const reconcile = vi.fn();
    const queue = createLatestMutationQueue(reconcile);

    queue.enqueue(async () => {
      await firstGate;
      throw new Error("old failed");
    });
    queue.enqueue(async () => undefined);
    releaseFirst();
    await queue.whenIdle();

    expect(reconcile).not.toHaveBeenCalled();
  });

  it("reconciles once when the final snapshot fails", async () => {
    const reconcile = vi.fn();
    const queue = createLatestMutationQueue(reconcile);

    queue.enqueue(async () => {
      throw new Error("latest failed");
    });
    await queue.whenIdle();

    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it("runs a new latest mutation that arrives during failure reconciliation", async () => {
    const events: string[] = [];
    let releaseReconcile!: () => void;
    const reconcileGate = new Promise<void>((resolve) => {
      releaseReconcile = resolve;
    });
    const queue = createLatestMutationQueue(async () => {
      events.push("reconcile:start");
      await reconcileGate;
      events.push("reconcile:end");
    });

    queue.enqueue(async () => {
      throw new Error("save failed");
    });
    await vi.waitFor(() => expect(events).toEqual(["reconcile:start"]));
    queue.enqueue(async () => {
      events.push("latest");
    });
    releaseReconcile();
    await queue.whenIdle();

    expect(events).toEqual(["reconcile:start", "reconcile:end", "latest"]);
  });

  it("reconciles even when a rejected promise has a null reason", async () => {
    const reconcile = vi.fn();
    const queue = createLatestMutationQueue(reconcile);

    queue.enqueue(() => Promise.reject(null));
    await queue.whenIdle();

    expect(reconcile).toHaveBeenCalledWith(null);
  });
});
