// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ save: vi.fn(), post: vi.fn(), flash: vi.fn() }));
vi.mock("../src/lib/downloadDir", () => ({ saveToDownloadDir: mocks.save }));
vi.mock("../src/lib/assetBroadcast", () => ({ postAssetsUpdated: mocks.post }));
vi.mock("../src/lib/flash", () => ({ flashMsg: mocks.flash }));
import { downloadOne, fetchBlob, type DownloadScope } from "../src/lib/download";
import { assertOperationContextCurrent, captureOperationContext } from "../src/app/operationContext";
import { setAccountScope } from "../src/lib/accountScope";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const scope = (): DownloadScope => {
  const context = captureOperationContext({ scope: "unknown", id: null, name: null });
  return { context, assertCurrent: () => assertOperationContextCurrent(context) };
};
const response = () => ({ ok: true, blob: async () => new Blob(["bytes"]) });
async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
beforeEach(() => {
  vi.useFakeTimers(); mocks.save.mockReset(); mocks.post.mockReset(); mocks.flash.mockReset();
  mocks.save.mockResolvedValue(true); setAccountScope("download-test-a");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response()));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it.each([undefined, "generation"])("문맥이 바뀐 fetch 실패는 proxy/직접 폴백을 시작하지 않는다 (gen=%s)", async (genId) => {
  const request = deferred<ReturnType<typeof response>>(); const fetcher = vi.fn().mockReturnValue(request.promise); vi.stubGlobal("fetch", fetcher);
  const guard = scope(); const result = fetchBlob("https://cdn.example/a.png", "a.png", genId, { assertCurrent: guard.assertCurrent });
  const settled = expect(result).rejects.toThrow("계정 또는 서버");
  setAccountScope("download-test-b"); request.reject(new Error("offline"));
  await settled; expect(fetcher).toHaveBeenCalledTimes(1);
});

it("응답 body를 받는 동안 계정이 바뀌면 파일을 저장하지 않는다", async () => {
  const bytes = deferred<Blob>(); vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, blob: () => bytes.promise }));
  const result = downloadOne("/api/assets/file?project=imports&path=a.png", "a.png", undefined, false, scope());
  const settled = expect(result).rejects.toThrow("계정 또는 서버"); await flush();
  setAccountScope("download-test-b"); bytes.resolve(new Blob(["old bytes"])); await settled;
  expect(mocks.save).not.toHaveBeenCalled(); expect(mocks.post).not.toHaveBeenCalled();
});

it("폴더 저장의 기존 guard에 전달하고 대기 중 변경되면 브라우저 링크로 우회하지 않는다", async () => {
  const permission = deferred<void>(); const write = vi.fn(); const anchor = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  mocks.save.mockImplementation(async (_name: string, _blob: Blob, assertCurrent: () => void) => {
    await permission.promise; assertCurrent(); write(); return true;
  });
  const result = downloadOne("/media/a.png", "a.png", undefined, false, scope());
  const settled = expect(result).rejects.toThrow("계정 또는 서버"); await flush();
  expect(mocks.save.mock.calls[0][2]).toBeTypeOf("function");
  setAccountScope("download-test-b"); permission.resolve(); await settled;
  expect(write).not.toHaveBeenCalled(); expect(anchor).not.toHaveBeenCalled();
});

it.each([true, false])("저장 완료 뒤에도 문맥을 확인하여 후속 알림/anchor를 막는다 (saved=%s)", async (saved) => {
  const saving = deferred<boolean>(); mocks.save.mockReturnValue(saving.promise);
  const anchor = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  const result = downloadOne("/media/a.png", "a.png", undefined, false, scope());
  const settled = expect(result).rejects.toThrow("계정 또는 서버"); await flush();
  setAccountScope("download-test-b"); saving.resolve(saved); await settled;
  await vi.advanceTimersByTimeAsync(200);
  expect(anchor).not.toHaveBeenCalled(); expect(mocks.post).not.toHaveBeenCalled();
});

it("저장 뒤 200ms 사이 계정이 바뀌면 새 Assets 화면을 갱신하지 않는다", async () => {
  await expect(downloadOne("/media/a.png", "a.png", undefined, false, scope())).resolves.toBe(true);
  setAccountScope("download-test-b"); await vi.advanceTimersByTimeAsync(200);
  expect(mocks.post).not.toHaveBeenCalled();
});

it("같은 문맥의 같은 파일은 합류하지만 scoped/unscoped 및 다른 계정은 합류하지 않는다", async () => {
  const requests: ReturnType<typeof deferred<ReturnType<typeof response>>>[] = [];
  const fetcher = vi.fn(() => { const item = deferred<ReturnType<typeof response>>(); requests.push(item); return item.promise; });
  vi.stubGlobal("fetch", fetcher);
  const first = downloadOne("/media/a.png", "a.png", undefined, false, scope());
  const same = downloadOne("/media/a.png", "a.png", undefined, false, scope());
  const unscoped = downloadOne("/media/a.png", "a.png");
  expect(fetcher).toHaveBeenCalledTimes(2);
  setAccountScope("download-test-b");
  const otherAccount = downloadOne("/media/a.png", "a.png");
  const results = Promise.allSettled([first, same, unscoped, otherAccount]);
  expect(fetcher).toHaveBeenCalledTimes(3);
  requests.forEach(item => item.resolve(response()));
  expect((await results).map(item => item.status)).toEqual(["rejected", "rejected", "fulfilled", "fulfilled"]);
  expect(mocks.save).toHaveBeenCalledTimes(2);
});

it("같은 scoped 문맥의 중복은 저장과 지연 알림이 각각 한 번이다", async () => {
  const request = deferred<ReturnType<typeof response>>(); const fetcher = vi.fn().mockReturnValue(request.promise); vi.stubGlobal("fetch", fetcher);
  const results = Promise.all([downloadOne("/media/a.png", "a.png", undefined, false, scope()), downloadOne("/media/a.png", "a.png", undefined, false, scope())]);
  request.resolve(response()); expect(await results).toEqual([true, true]);
  await vi.advanceTimersByTimeAsync(200);
  expect(fetcher).toHaveBeenCalledTimes(1); expect(mocks.save).toHaveBeenCalledTimes(1); expect(mocks.post).toHaveBeenCalledTimes(1);
});
