// comfy 실행 판정 상태기계 특성화 (R1) — 버그 3건의 재발 지점을 테스트로 고정.
import { describe, it, expect } from "vitest";
import { computeMaxParallel, createLimiter, createBatchTracker } from "../src/lib/comfyRunState";

describe("computeMaxParallel", () => {
  it("단일 comfy batch N → N 병렬, comfy N개 batch 1 → N 병렬", () => {
    expect(computeMaxParallel(4, 1)).toBe(4);
    expect(computeMaxParallel(1, 4)).toBe(4);
    expect(computeMaxParallel(1, 1)).toBe(1);
  });
  it("큰 보드는 8 상한, 단 batch 자체가 8보다 크면 batch 만큼", () => {
    expect(computeMaxParallel(4, 4)).toBe(8); // min(8,16)
    expect(computeMaxParallel(2, 3)).toBe(6);
  });
});

describe("createLimiter", () => {
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));
  it("동시 실행이 상한을 넘지 않고, FIFO 순서로 시작한다", async () => {
    const lim = createLimiter(2);
    let active = 0;
    let peak = 0;
    const started: number[] = [];
    const resolvers: (() => void)[] = [];
    const job = (i: number) =>
      lim.run(() => {
        started.push(i);
        active++;
        peak = Math.max(peak, active);
        return new Promise<void>((res) => resolvers.push(() => { active--; res(); }));
      });
    const all = Promise.all([job(0), job(1), job(2), job(3)]);
    await tick();
    expect(started).toEqual([0, 1]); // 상한 2 — 2개만 시작
    resolvers.shift()!();
    await tick();
    expect(started).toEqual([0, 1, 2]); // 슬롯 반환 → FIFO 로 다음 시작
    resolvers.shift()!();
    resolvers.shift()!();
    await tick();
    resolvers.shift()!();
    await all;
    expect(peak).toBe(2);
  });
  it("reject 돼도 슬롯이 반환돼 다음 작업이 시작된다", async () => {
    const lim = createLimiter(1);
    const p1 = lim.run(() => Promise.reject(new Error("boom")));
    let ran = false;
    const p2 = lim.run(async () => { ran = true; });
    await expect(p1).rejects.toThrow("boom");
    await p2;
    expect(ran).toBe(true);
  });
  it("동기 throw 에서도 슬롯이 반환된다(슬롯 누수 방지)", async () => {
    const lim = createLimiter(1);
    const p1 = lim.run(() => { throw new Error("sync"); });
    let ran = false;
    const p2 = lim.run(async () => { ran = true; });
    await expect(p1).rejects.toThrow("sync");
    await p2;
    expect(ran).toBe(true);
  });
  it("비정상 상한(0·NaN·소수)은 정수 1 이상으로 안전화", async () => {
    for (const cap of [0, NaN, -3]) {
      const lim = createLimiter(cap);
      let ran = false;
      await lim.run(async () => { ran = true; });
      expect(ran).toBe(true); // 1 로 안전화돼 실행은 된다
    }
    // 소수 상한은 내림(floor) — 1.9 면 동시 1개만
    const lim = createLimiter(1.9);
    let active = 0;
    let peak = 0;
    const resolvers: (() => void)[] = [];
    const jobs = [0, 1].map(() =>
      lim.run(() => {
        active++;
        peak = Math.max(peak, active);
        return new Promise<void>((res) => resolvers.push(() => { active--; res(); }));
      }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(peak).toBe(1);
    resolvers.shift()!();
    await new Promise((r) => setTimeout(r, 0));
    resolvers.shift()!();
    await Promise.all(jobs);
    expect(peak).toBe(1);
  });
});

describe("createBatchTracker", () => {
  const ok = (v: string, elapsed = 1) => ({ kind: "success" as const, outputs: [v], elapsed });
  const fail = (e: string) => ({ kind: "failed" as const, error: e });
  const skip = () => ({ kind: "skipped" as const });

  it("마지막 copy 정산 때 정확히 1회 finalize, 대표=copyIndex 최대 성공본(정산 순서 무관)", () => {
    const t = createBatchTracker<string[]>(["a"], 3);
    expect(t.settle("a", 2, ok("v2"))).toBeNull(); // 늦은 copy 가 먼저 와도
    expect(t.settle("a", 0, ok("v0"))).toBeNull();
    const fin = t.settle("a", 1, ok("v1"));
    expect(fin).not.toBeNull();
    expect(fin!.rep!.copyIndex).toBe(2); // 대표 = 마지막(최대 index) 성공
    expect(fin!.rep!.outputs).toEqual(["v2"]);
    expect(fin!.failCount).toBe(0);
    expect(t.settle("a", 0, ok("late"))).toBeNull(); // finalize 후 늦은 정산 무시
  });
  it("전 copy 실패 → rep null + firstError 는 첫 failed 메시지", () => {
    const t = createBatchTracker<string[]>(["a"], 2);
    expect(t.settle("a", 0, fail("first"))).toBeNull();
    const fin = t.settle("a", 1, fail("second"));
    expect(fin!.rep).toBeNull();
    expect(fin!.failCount).toBe(2);
    expect(fin!.firstError).toBe("first");
  });
  it("skipped 는 실패 수에 포함하되 firstError 는 남기지 않는다(abort·상류실패 의미)", () => {
    const t = createBatchTracker<string[]>(["a"], 2);
    t.settle("a", 0, skip());
    const fin = t.settle("a", 1, ok("v"));
    expect(fin!.failCount).toBe(1);
    expect(fin!.firstError).toBeUndefined();
    expect(fin!.rep!.outputs).toEqual(["v"]);
  });
  it("같은 copy 중복 정산은 무시 — 조기 finalize 를 일으키지 못한다", () => {
    const t = createBatchTracker<string[]>(["a"], 2);
    expect(t.settle("a", 0, ok("v"))).toBeNull();
    expect(t.settle("a", 0, ok("dup"))).toBeNull(); // 중복 — settled 2 로 세지 않음
    const fin = t.settle("a", 1, ok("w"));
    expect(fin).not.toBeNull(); // 진짜 두 번째 copy 가 와야 finalize
  });
  it("범위 밖 copyIndex·모르는 id 는 무시", () => {
    const t = createBatchTracker<string[]>(["a"], 2);
    expect(t.settle("a", 5, ok("x"))).toBeNull();
    expect(t.settle("a", -1, ok("x"))).toBeNull();
    expect(t.settle("ghost", 0, ok("x"))).toBeNull();
    expect(t.settle("a", 0, ok("v"))).toBeNull();
    expect(t.settle("a", 1, ok("w"))).not.toBeNull(); // 무시분이 정산 수를 오염 안 함
  });
  it("releaseOnce 는 노드당 정확히 1회 true(웨이브 해제 count 균형)", () => {
    const t = createBatchTracker<string[]>(["a", "b"], 1);
    expect(t.releaseOnce("a")).toBe(true);
    expect(t.releaseOnce("a")).toBe(false);
    expect(t.releaseOnce("b")).toBe(true);
  });
});
