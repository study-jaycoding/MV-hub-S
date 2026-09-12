import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchModelCatalog, resetModelCatalogCache } from "../src/lib/modelCatalogCache";
import type { ModelInfo } from "../src/types";

// 모델 목록 HTTP 를 훅 인스턴스마다 다시 보내지 않는다.
//
// ★왜(2026-09-12): `useModels` 는 세 곳(SpotlightPrompt·SceneModelModal·PartialEditModal)에서 쓰이고
//  모달은 열 때마다 마운트된다. 실측 `/api/models` 는 첫 회 1,839ms(CLI)·이후 2.6ms·7.4KB.
//  **1.84초를 없애는 작업이 아니다** — 서버가 이미 5분 TTL 과 single-flight 를 한다.
//  여기서 줄이는 것은 HTTP 왕복 그 자체다.

const MODELS: ModelInfo[] = [
  { display_name: "Seedance 2.5", job_set_type: "seedance_2_5", type: "video" },
  { display_name: "Nano Banana 2", job_set_type: "nano_banana_flash", type: "image" },
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  resetModelCatalogCache();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-12T00:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  resetModelCatalogCache();
});

describe("모델 목록 캐시", () => {
  it("★겹쳐 부르면 한 번만 왕복하고 같은 값을 준다", async () => {
    const gate = deferred<ModelInfo[]>();
    const fetcher = vi.fn().mockReturnValue(gate.promise);

    const a = fetchModelCatalog(fetcher);
    const b = fetchModelCatalog(fetcher);
    const c = fetchModelCatalog(fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);

    gate.resolve(MODELS);
    expect(await a).toEqual(MODELS);
    expect(await b).toEqual(MODELS);
    expect(await c).toEqual(MODELS);
  });

  it("TTL 안에서는 다시 묻지 않는다", async () => {
    const fetcher = vi.fn().mockResolvedValue(MODELS);
    expect(await fetchModelCatalog(fetcher)).toEqual(MODELS);
    vi.advanceTimersByTime(59_000);
    expect(await fetchModelCatalog(fetcher)).toEqual(MODELS);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("TTL 이 지나면 다시 묻는다 — 영원히 굳지 않는다", async () => {
    const fetcher = vi.fn().mockResolvedValue(MODELS);
    await fetchModelCatalog(fetcher);
    vi.advanceTimersByTime(61_000);
    await fetchModelCatalog(fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("★빈 목록은 캐시하지 않는다 — 일시 실패로 모델 선택이 60초 동안 막히면 안 된다", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce(MODELS);
    expect(await fetchModelCatalog(fetcher)).toEqual([]);
    expect(await fetchModelCatalog(fetcher)).toEqual(MODELS); // 곧바로 다시 묻는다
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("★실패는 캐시하지 않고 다음 호출이 다시 시도한다", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error("502"))
      .mockResolvedValueOnce(MODELS);
    await expect(fetchModelCatalog(fetcher)).rejects.toThrow("502");
    expect(await fetchModelCatalog(fetcher)).toEqual(MODELS);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("한 번의 실패는 합류한 쪽 모두에게 전해진다 — 조용히 빈 목록이 되지 않는다", async () => {
    const gate = deferred<ModelInfo[]>();
    const fetcher = vi.fn().mockReturnValue(gate.promise);
    const a = fetchModelCatalog(fetcher);
    const b = fetchModelCatalog(fetcher);
    gate.reject(new Error("끊김"));
    await expect(a).rejects.toThrow("끊김");
    await expect(b).rejects.toThrow("끊김");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("앞 요청이 끝난 뒤 들어온 호출은 그 결과를 쓴다(합류가 새 요청으로 새지 않게)", async () => {
    const gate = deferred<ModelInfo[]>();
    const fetcher = vi.fn().mockReturnValue(gate.promise);
    const first = fetchModelCatalog(fetcher);
    gate.resolve(MODELS);
    await first;
    expect(await fetchModelCatalog(fetcher)).toEqual(MODELS);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
