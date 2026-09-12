import { describe, expect, it, vi } from "vitest";
import { startLibraryRequests } from "../src/lib/libraryRequestPlan";

// 라이브러리 첫 로드의 **요청 시작 순서** 계약.
//
// ★왜 이 시험이 있나(2026-09-12 실측): 종전에는 목록을 `await` 한 **뒤에야** 메타 세 개를
//  시작하는 직렬 폭포였다. 로컬 실측으로 목록 `/api/generations?limit=200` 이 47ms·3.38MB,
//  `/api/projects` 가 61ms 다 — 직렬이면 전부 갖춰지는 데 ≈108ms, 함께 시작하면 ≈61ms.
//  **그리드가 보이는 시각은 바뀌지 않는다.** 빨라지는 것은 왼쪽 폴더·태그·배지다.
//
// ★렌더 시험 인프라가 없어(testing-library·jsdom 미설치) 훅을 직접 돌릴 수 없다.
//  그래서 순서 계약만 순수 함수로 떼어내 여기서 검사한다.

/** 밖에서 풀어 줄 수 있는 약속 — "아직 안 끝난 요청"을 만든다. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("라이브러리 첫 로드 요청 계획", () => {
  it("★목록이 끝나기 전에 메타 세 개가 이미 떠 있다", async () => {
    const listGate = deferred<string[]>();
    const started: string[] = [];
    const mark = (name: string) => () => {
      started.push(name);
      return Promise.resolve(name);
    };

    const { list, meta } = startLibraryRequests(
      () => {
        started.push("list");
        return listGate.promise;
      },
      mark("stats"),
      mark("facets"),
      mark("projects"),
    );

    // 목록은 아직 응답하지 않았다 — 그런데도 메타는 이미 시작돼 있어야 한다.
    expect(started).toEqual(["list", "stats", "facets", "projects"]);

    listGate.resolve(["g1"]);
    await expect(list).resolves.toEqual(["g1"]);
    await expect(meta).resolves.toEqual(["stats", "facets", "projects"]);
  });

  it("그리드는 메타를 기다리지 않는다 — 메타가 멈춰 있어도 목록을 받는다", async () => {
    const metaGate = deferred<string>();
    const { list, meta } = startLibraryRequests(
      () => Promise.resolve(["g1", "g2"]),
      () => metaGate.promise,
      () => metaGate.promise,
      () => metaGate.promise,
    );

    await expect(list).resolves.toEqual(["g1", "g2"]);

    let metaDone = false;
    void meta.then(() => {
      metaDone = true;
    });
    await Promise.resolve();
    expect(metaDone).toBe(false); // 목록을 다 받은 뒤에도 메타는 아직이다

    metaGate.resolve("늦게");
    await expect(meta).resolves.toEqual(["늦게", "늦게", "늦게"]);
  });

  it("★메타 하나가 실패해도 나머지와 목록은 살아남는다", async () => {
    const { list, meta } = startLibraryRequests(
      () => Promise.resolve(["g1"]),
      () => Promise.reject(new Error("stats 폭발")),
      () => Promise.resolve("facets"),
      () => Promise.reject(new Error("projects 폭발")),
    );

    await expect(list).resolves.toEqual(["g1"]);
    await expect(meta).resolves.toEqual([null, "facets", null]);
  });

  it("★목록이 실패해도 메타는 취소되지 않는다 — 실패는 서로 격리된다", async () => {
    const projects = vi.fn().mockResolvedValue("projects");
    const { list, meta } = startLibraryRequests(
      () => Promise.reject(new Error("목록 폭발")),
      () => Promise.resolve("stats"),
      () => Promise.resolve("facets"),
      projects,
    );

    await expect(list).rejects.toThrow("목록 폭발");
    await expect(meta).resolves.toEqual(["stats", "facets", "projects"]);
    expect(projects).toHaveBeenCalledTimes(1);
  });

  it("생략한 요청은 부르지 않고 자리에 null 을 채운다", async () => {
    // `light` 로드는 태그·폴더를 건너뛰고, 통계는 10초 스로틀에 걸리면 건너뛴다.
    const stats = vi.fn().mockResolvedValue("stats");
    const { meta } = startLibraryRequests(() => Promise.resolve([]), stats, null, null);
    await expect(meta).resolves.toEqual(["stats", null, null]);
    expect(stats).toHaveBeenCalledTimes(1);

    const nothing = startLibraryRequests(() => Promise.resolve([]), null, null, null);
    await expect(nothing.meta).resolves.toEqual([null, null, null]);
  });

  it("요청은 딱 한 번씩만 나간다", async () => {
    const listFn = vi.fn().mockResolvedValue([]);
    const statsFn = vi.fn().mockResolvedValue("s");
    const facetsFn = vi.fn().mockResolvedValue("f");
    const projectsFn = vi.fn().mockResolvedValue("p");

    const { list, meta } = startLibraryRequests(listFn, statsFn, facetsFn, projectsFn);
    await Promise.all([list, meta]);
    await Promise.all([list, meta]); // 두 번 기다려도 재요청은 없다

    for (const fn of [listFn, statsFn, facetsFn, projectsFn]) {
      expect(fn).toHaveBeenCalledTimes(1);
    }
  });

  it("★메타를 아무도 기다리지 않아도 처리 안 된 거절이 남지 않는다", async () => {
    // 훅은 요청 순번이 어긋나면 메타를 `await` 하지 않고 돌아간다.
    // 그때 메타가 거절된 채 남으면 콘솔에 unhandled rejection 이 뜬다.
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      startLibraryRequests(
        () => Promise.resolve([]),
        () => Promise.reject(new Error("아무도 안 봄")),
        () => Promise.reject(new Error("이것도")),
        () => Promise.reject(new Error("저것도")),
      );
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
