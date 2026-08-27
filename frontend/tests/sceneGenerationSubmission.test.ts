import { describe, expect, it, vi } from "vitest";
import {
  acquireSceneGeneration,
  executeSceneGenerationBatch,
} from "../src/lib/sceneGenerationSubmission";
import type { SceneCard } from "../src/lib/scenes";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const card = (id: string, over: Partial<SceneCard> = {}): SceneCard => ({
  id,
  kind: "generation",
  x: 0,
  y: 0,
  ...over,
});

describe("sceneGenerationSubmission", () => {
  it("같은 씬 재진입만 막고 다른 씬은 동시에 실행한다", () => {
    const active = new Set<string>();
    const releaseA = acquireSceneGeneration(active, "A");
    const releaseB = acquireSceneGeneration(active, "B");

    expect(releaseA).toBeTypeOf("function");
    expect(releaseB).toBeTypeOf("function");
    expect(acquireSceneGeneration(active, "A")).toBeNull();
    releaseA?.();
    releaseA?.(); // 중복 해제도 안전
    expect(acquireSceneGeneration(active, "A")).toBeTypeOf("function");
    releaseB?.();
  });

  it("느린 작업을 기다리지 않고 준비된 다른 작업을 제출·반영한다", async () => {
    const slow = deferred<string>();
    const submitted: string[] = [];
    const applied: string[] = [];

    const running = executeSceneGenerationBatch(
      [
        { cardId: "slow-card", input: "slow" },
        { cardId: "fast-card", input: "fast" },
      ],
      async (input) => (input === "slow" ? slow.promise : "fast-body"),
      async (body) => {
        submitted.push(body);
        return `gen:${body}`;
      },
      ({ result }) => applied.push(result),
    );

    await vi.waitFor(() => expect(applied).toEqual(["gen:fast-body"]));
    expect(submitted).toEqual(["fast-body"]);

    slow.resolve("slow-body");
    const summary = await running;
    expect(submitted).toEqual(["fast-body", "slow-body"]);
    expect(applied).toEqual(["gen:fast-body", "gen:slow-body"]); // 실제 완료 순서
    expect(summary.successes.map((item) => item.result)).toEqual([
      "gen:slow-body",
      "gen:fast-body",
    ]); // 최종 배치 순서는 입력 순서
  });

  it("준비 실패와 제출 실패를 분리해 집계한다", async () => {
    const summary = await executeSceneGenerationBatch(
      [
        { cardId: "build-null", input: "null" },
        { cardId: "build-throw", input: "throw" },
        { cardId: "submit-fail", input: "reject" },
        { cardId: "ok", input: "ok" },
      ],
      async (input) => {
        if (input === "null") return null;
        if (input === "throw") throw new Error("prepare");
        return input;
      },
      async (body) => {
        if (body === "reject") throw new Error("submit");
        return body;
      },
    );

    expect(summary).toEqual({
      successes: [{ cardId: "ok", result: "ok" }],
      buildFail: 2,
      submitFail: 1,
      applyFail: 0,
    });
  });

  it("로컬 반영 오류를 제출 실패로 오분류하거나 다른 작업보다 일찍 종료하지 않는다", async () => {
    const slow = deferred<string>();
    const running = executeSceneGenerationBatch(
      [
        { cardId: "apply-fail", input: "first" },
        { cardId: "slow", input: "slow" },
      ],
      async (input) => input,
      async (body) => (body === "slow" ? slow.promise : body),
      ({ cardId }) => {
        if (cardId === "apply-fail") throw new Error("localStorage full");
      },
    );

    let finished = false;
    void running.then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    slow.resolve("second");
    const summary = await running;
    expect(summary.successes).toHaveLength(2);
    expect(summary.submitFail).toBe(0);
    expect(summary.applyFail).toBe(1);
  });
});
