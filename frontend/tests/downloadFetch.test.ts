import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchBlob } from "../src/lib/download";

type FetchResult = Pick<Response, "ok" | "blob">;

function response(ok: boolean, blob?: Blob): FetchResult {
  return {
    ok,
    blob: vi.fn().mockResolvedValue(blob ?? new Blob()),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchBlob", () => {
  it("로컬 URL은 인증 쿠키를 포함해 직접 가져온다", async () => {
    const expected = new Blob(["local"]);
    const fetchMock = vi.fn().mockResolvedValue(response(true, expected));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchBlob("/media/input.png", "input.png")).resolves.toBe(expected);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith("/media/input.png", { credentials: "include" });
  });

  it("로컬 직접 요청이 실패하면 외부 프록시로 보내지 않는다", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchBlob("/media/missing.png", "missing.png")).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("원격 URL은 CORS 직접 요청이 성공하면 그대로 사용한다", async () => {
    const expected = new Blob(["remote"]);
    const fetchMock = vi.fn().mockResolvedValue(response(true, expected));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchBlob("https://cdn.example/result.png", "result.png"),
    ).resolves.toBe(expected);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith("https://cdn.example/result.png", {});
  });

  it("원격 직접 요청 실패 시 인증된 서버 프록시로 한 번 재시도한다", async () => {
    const expected = new Blob(["proxy"]);
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("cors"))
      .mockResolvedValueOnce(response(true, expected));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchBlob("https://cdn.example/a b.png?x=1", "ref one.png"),
    ).resolves.toBe(expected);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/download?url=https%3A%2F%2Fcdn.example%2Fa+b.png%3Fx%3D1&name=ref+one.png",
      { credentials: "include" },
    );
  });

  it("원격 직접 요청과 프록시가 모두 실패하면 null을 반환한다", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(false))
      .mockRejectedValueOnce(new Error("proxy offline"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchBlob("https://cdn.example/missing.png", "missing.png"),
    ).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // 수정 창의 로딩 링(11-09 Jay 시안 A2) — 받은 양을 알린다. 알림을 안 주는 호출은 위 시험들처럼 res.blob() 그대로다
  const streamed = (headers: Record<string, string>) => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      controller.enqueue(new Uint8Array([4, 5]));
      controller.close();
    },
  }), { headers });

  it("진행 알림을 주면 받은 바이트·전체를 알리고 같은 내용을 돌려준다", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(streamed({ "Content-Length": "5", "Content-Type": "image/png" })));
    const seen: [number, number | null][] = [];
    const blob = await fetchBlob("https://cdn.example/a.png", "a.png", undefined, { onProgress: (loaded, total) => seen.push([loaded, total]) });
    expect(seen).toEqual([[0, 5], [3, 5], [5, 5]]);
    expect(blob?.type).toBe("image/png");
    expect([...new Uint8Array(await blob!.arrayBuffer())]).toEqual([1, 2, 3, 4, 5]);
  });

  it("전체 크기를 모르면 total 은 null 로 알린다", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(streamed({})));
    const totals: (number | null)[] = [];
    await fetchBlob("https://cdn.example/a.mp4", "a.mp4", undefined, { onProgress: (_loaded, total) => totals.push(total) });
    expect(totals).toEqual([null, null, null]);
  });
});
