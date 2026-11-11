// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCardAtlas, type AtlasBudgets, type AtlasRequest, type AtlasUploader } from "../src/features/canvas/gpu/cardAtlas";
import { createGpuRenderer, type GpuScene } from "../src/features/canvas/gpu/gpuRenderer";

function harness(budgets: Partial<AtlasBudgets> = {}) {
  let clock = 0;
  const pages = new Map<number, { width: number; height: number }>();
  const events: string[] = [];
  const g = { save: vi.fn(), restore: vi.fn(), setTransform: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn() };
  const canvases: Array<{ width: number; height: number }> = [];
  const uploader: AtlasUploader = {
    ensurePage: vi.fn((id, width, height = width) => { pages.set(id, { width, height }); events.push(`add:${id}`); }),
    upload: vi.fn((page) => { events.push(`upload:${page}`); }),
    deletePage: vi.fn((id) => { pages.delete(id); events.push(`delete:${id}`); }),
  };
  const decode = vi.fn<(...args: [string, number, number]) => Promise<ImageBitmap | null>>().mockResolvedValue(null);
  const atlas = createCardAtlas({
    now: () => clock,
    makeCanvas: (width, height) => {
      const canvas = { width, height, getContext: () => g };
      canvases.push(canvas);
      return canvas as unknown as HTMLCanvasElement;
    },
    uploader, decode, budgets,
  });
  const request = (id: string, w = 40, h = 20, cost = 0): AtlasRequest => ({
    id, key: id, w, h, sources: [], draw: vi.fn(() => { clock += cost; }),
  });
  const sync = (reqs: AtlasRequest[], scale = 1, visible = reqs.map((r) => r.id), generation = 1) => atlas.sync(reqs, new Set(visible), scale, generation);
  return { atlas, request, sync, uploader, decode, g, pages, events, canvases };
}

function bitmap(width = 8, height = 8) {
  return { width, height, close: vi.fn() } as unknown as ImageBitmap;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("cardAtlas", () => {
  it("그릴 수 없는 그림(undrawable)은 지금 작업일 때만 onUndrawable 로 알리고 그림 없이 굽는다 — 취소된 작업의 늦은 결과는 버린다", async () => {
    const onUndrawable = vi.fn();
    const pending = new Map<string, ReturnType<typeof deferred<ImageBitmap | null | "undrawable">>>();
    const g = { save: vi.fn(), restore: vi.fn(), setTransform: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn() };
    const atlas = createCardAtlas({
      now: () => 0, makeCanvas: (width, height) => ({ width, height, getContext: () => g }) as unknown as HTMLCanvasElement,
      uploader: { ensurePage: vi.fn(), upload: vi.fn(), deletePage: vi.fn() },
      decode: (src) => { const d = deferred<ImageBitmap | null | "undrawable">(); pending.set(src, d); return d.promise; },
      onUndrawable,
    });
    const req = (id: string, src: string): AtlasRequest => ({ id, key: id, w: 40, h: 20, sources: [src], draw: vi.fn() });
    atlas.sync([req("a", "/a")], new Set(["a"]), 1, 1);
    atlas.tick(); // a 의 디코드 시작
    atlas.sync([req("b", "/b")], new Set(["b"]), 1, 1);
    atlas.tick(); // a 를 취소하고 b 시작
    pending.get("/a")!.resolve("undrawable");
    await flush();
    expect(onUndrawable).not.toHaveBeenCalled();
    pending.get("/b")!.resolve("undrawable");
    await flush();
    expect(onUndrawable.mock.calls).toEqual([["b"]]);
    for (let i = 0; i < 3; i++) atlas.tick();
    expect(atlas.lookup("b")).not.toBeNull(); // 그림 없이 구웠다(그 카드는 SceneBoard 가 미지원으로 센다)
  });

  it("열쇠 불변·위치만 변경은 굽기 0, 열쇠 변경은 그 카드만", () => {
    const h = harness();
    const a = h.request("a"), b = h.request("b");
    h.sync([a, b]);
    expect(h.atlas.tick().baked).toBe(2);
    h.sync([{ ...a }, { ...b }]);
    expect(h.atlas.tick().baked).toBe(0);
    const moved = { ...a, x: 100, y: 200 };
    h.sync([moved, b]);
    expect(h.atlas.tick().baked).toBe(0);
    h.sync([{ ...moved, key: "new" }, b]);
    expect(h.atlas.tick().baked).toBe(1);
    expect(a.draw).toHaveBeenCalledTimes(2);
    expect(b.draw).toHaveBeenCalledTimes(1);
  });

  it.each([[0.1, 0.25], [0.3125, 0.25], [0.313, 0.5], [0.625, 0.5], [0.626, 1], [1.25, 1], [1.251, 2], [2.5, 2]])("배율 %s의 가장 작은 단계는 %s", (scale, tier) => {
    const h = harness();
    h.sync([h.request("a")], scale);
    h.atlas.tick();
    expect(h.atlas.lookup("a")?.tier).toBe(tier);
  });

  it("보이는 카드 우선, 화면 밖은 1/4 단계", () => {
    const h = harness();
    const a = h.request("a", 40, 20, 5), b = h.request("b", 40, 20, 5);
    h.sync([a, b], 2, ["b"]);
    h.atlas.tick();
    expect(h.atlas.lookup("b")?.tier).toBe(2);
    expect(h.atlas.lookup("a")).toBeNull();
    h.atlas.tick();
    expect(h.atlas.lookup("a")?.tier).toBe(0.25);
  });

  it("4ms를 넘기는 단위는 최대 하나이고 업로드 픽셀도 상한 이내", () => {
    const h = harness({ uploadPx: 100 });
    h.sync([h.request("a", 5, 5, 3), h.request("b", 5, 5, 3), h.request("c", 5, 5, 3)]);
    expect(h.atlas.tick()).toMatchObject({ baked: 2, uploadedPx: 50, pending: 1 });
    expect(h.atlas.tick()).toMatchObject({ baked: 1, uploadedPx: 25, pending: 0 });
    const many = harness({ uploadPx: 100 });
    many.sync([many.request("a", 8, 8), many.request("b", 8, 8)]);
    expect(many.atlas.tick()).toMatchObject({ baked: 1, uploadedPx: 64 });
    expect(many.atlas.tick()).toMatchObject({ baked: 1, uploadedPx: 64 });
  });

  it("큰 카드의 띠는 프레임마다 하나, 전부 완성할 때까지 옛 영역 유지", () => {
    const h = harness({ uploadPx: 64, pageSize: 16 });
    const a = h.request("a", 16, 32);
    h.sync([a], 0.25);
    h.atlas.tick();
    const old = h.atlas.lookup("a");
    h.sync([a], 1);
    for (let i = 0; i < 8; i++) {
      expect(h.atlas.tick()).toMatchObject({ baked: 1, uploadedPx: 64 });
      if (i < 7) expect(h.atlas.lookup("a")).toBe(old);
    }
    expect(h.atlas.lookup("a")?.tier).toBe(1);
    expect(h.g.setTransform).toHaveBeenLastCalledWith(1, 0, 0, 1, 0, -28);
    expect(h.canvases.every((c) => c.width === 0 && c.height === 0)).toBe(true);
  });

  it("기본 4Mpx 상한에서도 큰 카드를 나누고 옛/새 텍스처를 함께 센다", () => {
    const h = harness();
    const a = h.request("a", 2048, 4096);
    h.sync([a], 0.25);
    h.atlas.tick();
    const before = h.atlas.textureBytes();
    h.sync([a]);
    expect(h.atlas.tick()).toMatchObject({ baked: 1, uploadedPx: 4 * 1024 * 1024, pending: 1 });
    expect(h.atlas.textureBytes()).toBe(before + 2048 * 4096 * 4);
    expect(h.atlas.textureBytes()).toBeLessThanOrEqual(128 * 1024 * 1024);
    expect(h.atlas.tick().pending).toBe(0);
    expect(h.atlas.textureBytes()).toBe(2048 * 4096 * 4);
  });

  it("자리 부족이면 화면 밖의 큰 단계부터 퇴출, 재등장하면 낮은 단계부터", () => {
    const h = harness({ pageSize: 4, textureBytes: 128 });
    const a = h.request("a", 2, 2, 5), b = h.request("b", 4, 4, 5), c = h.request("c", 4, 4, 5);
    h.sync([a], 2);
    h.atlas.tick();
    const aPage = h.atlas.lookup("a")!.page;
    h.sync([a, b], 1, ["b"]);
    h.atlas.tick();
    h.sync([a, b, c], 1, ["c"]);
    h.atlas.tick();
    expect(h.atlas.lookup("a")).toBeNull();
    expect(h.atlas.lookup("b")).not.toBeNull();
    expect(h.uploader.deletePage).toHaveBeenCalledWith(aPage);
    h.sync([a, b, c], 2, ["a"]);
    h.atlas.tick();
    expect(h.atlas.lookup("a")?.tier).toBe(0.25);
    expect(h.atlas.textureBytes()).toBeLessThanOrEqual(128);
  });

  it("화면 안 옛 그림은 예산 때문에 지우지 않고 실패를 호출자에게 알린다", () => {
    const h = harness({ pageSize: 4, textureBytes: 64 });
    const a = h.request("a", 4, 4);
    h.sync([a]); h.atlas.tick();
    const old = h.atlas.lookup("a");
    h.sync([{ ...a, key: "new" }]);
    expect(() => h.atlas.tick()).toThrow(/texture budget/);
    expect(h.atlas.lookup("a")).toBe(old);
    expect(h.atlas.textureBytes()).toBe(64);
  });

  it("화면 밖 자기 그림만 남아도 큰 단계를 버려 낮은 단계로 내려간다", () => {
    const h = harness({ pageSize: 4, textureBytes: 64 });
    const a = h.request("a", 4, 4);
    h.sync([a]); h.atlas.tick();
    h.sync([a], 1, []); h.atlas.tick();
    expect(h.atlas.lookup("a")?.tier).toBe(0.25);
    expect(h.atlas.textureBytes()).toBe(64);
  });

  it("디코드 동시 6, 굽는 폭으로 요청하고 구운 뒤 모든 비트맵 close", async () => {
    const h = harness();
    const pending = Array.from({ length: 9 }, () => deferred<ImageBitmap | null>());
    const images = pending.map(() => bitmap());
    h.decode.mockImplementation(() => pending[h.decode.mock.calls.length - 1].promise);
    const a = { ...h.request("a"), sources: pending.map((_, i) => `src${i}`) };
    h.sync([a]); h.atlas.tick();
    expect(h.decode).toHaveBeenCalledTimes(6);
    expect(h.decode).toHaveBeenCalledWith("src0", 40, 40);
    pending.slice(0, 6).forEach((p, i) => p.resolve(images[i]));
    await flush();
    expect(h.atlas.cpuBytes()).toBe(6 * 8 * 8 * 4);
    h.atlas.tick();
    expect(h.decode).toHaveBeenCalledTimes(9);
    pending.slice(6).forEach((p, i) => p.resolve(images[i + 6]));
    await flush();
    expect(h.atlas.tick().baked).toBe(1);
    for (const image of images) expect(image.close).toHaveBeenCalledTimes(1);
    expect(h.atlas.cpuBytes()).toBe(0);
  });

  it("reset 뒤 늦은 디코드는 닫고 다른 세대에 올리지 않는다", async () => {
    const h = harness();
    const pending = deferred<ImageBitmap | null>();
    h.decode.mockReturnValue(pending.promise);
    h.sync([{ ...h.request("a"), sources: ["src"] }]); h.atlas.tick();
    h.atlas.reset(2);
    const image = bitmap();
    pending.resolve(image); await flush();
    expect(image.close).toHaveBeenCalledTimes(1);
    expect(h.atlas.tick()).toEqual({ baked: 0, uploadedPx: 0, pending: 0 });
    expect(h.uploader.upload).not.toHaveBeenCalled();
    expect(h.atlas.textureBytes()).toBe(0);
    expect(h.atlas.cpuBytes()).toBe(0);
  });

  it("reset 중인 디코드도 실제 완료 전까지 동시량에 포함", async () => {
    const h = harness();
    const pending = deferred<ImageBitmap | null>();
    h.decode.mockReturnValue(pending.promise);
    const a = { ...h.request("a"), sources: Array.from({ length: 6 }, (_, i) => String(i)) };
    h.sync([a]); h.atlas.tick();
    h.sync([{ ...a, id: "b" }], 1, ["b"], 2); h.atlas.tick();
    expect(h.decode).toHaveBeenCalledTimes(6);
    pending.resolve(null); await flush(); h.atlas.tick();
    expect(h.decode).toHaveBeenCalledTimes(12);
  });

  it("디코드 실패·거절은 null로 draw에 전달", async () => {
    const h = harness();
    h.decode.mockRejectedValue(new Error("image failed"));
    const draw = vi.fn((_g, imageOf) => { expect(imageOf("src")).toBeNull(); });
    h.sync([{ ...h.request("a"), sources: ["src"], draw }]); h.atlas.tick();
    await flush(); h.atlas.tick();
    expect(draw).toHaveBeenCalledTimes(1);
  });

  it("CPU 상한을 넘는 비트맵은 즉시 닫고 굽기 전에 실패", async () => {
    const h = harness({ cpuBytes: 64 * 1024 * 1024 });
    const image = bitmap(4096, 4096);
    h.decode.mockResolvedValue(image);
    h.sync([{ ...h.request("a"), sources: ["src"] }]); h.atlas.tick();
    await flush();
    expect(image.close).toHaveBeenCalledTimes(1);
    expect(h.atlas.cpuBytes()).toBe(0);
    expect(() => h.atlas.tick()).toThrow(/requested dimensions/);
    expect(h.uploader.upload).not.toHaveBeenCalled();
  });

  it("굽는 동안 CPU 합계에 캔버스와 모든 비트맵이 함께 들어간다", async () => {
    const h = harness({ cpuBytes: 128 });
    const image = bitmap(4, 4);
    h.decode.mockResolvedValue(image);
    const draw = vi.fn(() => { expect(h.atlas.cpuBytes()).toBe(128); });
    h.sync([{ ...h.request("a", 4, 4), sources: ["src"], draw }]);
    h.atlas.tick(); await flush(); h.atlas.tick();
    expect(draw).toHaveBeenCalledTimes(1);
    expect(h.atlas.cpuBytes()).toBe(0);
    expect(h.atlas.cpuPeak()).toBe(128);
    h.atlas.reset(2);
    h.atlas.dispose();
    expect(h.atlas.cpuPeak()).toBe(128);
  });

  it("업로드 실패는 새 자원만 놓고 옛 그림을 보존한다", () => {
    const h = harness();
    const a = h.request("a");
    h.sync([a]); h.atlas.tick();
    const old = h.atlas.lookup("a");
    vi.mocked(h.uploader.upload).mockImplementationOnce(() => { throw new Error("upload failed"); });
    h.sync([{ ...a, key: "new" }]);
    expect(() => h.atlas.tick()).toThrow("upload failed");
    expect(h.atlas.lookup("a")).toBe(old);
    expect(h.atlas.cpuBytes()).toBe(0);
  });

  it("화면 밖 대기 중 새로 보이는 카드를 먼저 굽는다", async () => {
    const h = harness();
    const pending = deferred<ImageBitmap | null>();
    h.decode.mockReturnValue(pending.promise);
    const a = { ...h.request("a"), sources: ["slow"] }, b = h.request("b");
    h.sync([a], 1, []); h.atlas.tick();
    h.sync([a, b], 1, ["b"]); h.atlas.tick();
    expect(h.atlas.lookup("b")).not.toBeNull();
    const image = bitmap(); pending.resolve(image); await flush();
    h.atlas.dispose();
    expect(image.close).toHaveBeenCalled();
  });

  it("띠 사이 비트맵을 놓고, 내용 변경 중 남은 띠는 취소", async () => {
    const h = harness({ uploadPx: 16 });
    const images: ImageBitmap[] = [];
    h.decode.mockImplementation(async () => { const image = bitmap(2, 2); images.push(image); return image; });
    const a = { ...h.request("a", 4, 8), sources: ["src"] };
    h.sync([a]); h.atlas.tick(); await flush(); h.atlas.tick();
    expect(images[0].close).toHaveBeenCalledTimes(1);
    expect(h.atlas.lookup("a")).toBeNull();
    h.sync([{ ...a, key: "new", sources: [], h: 4 }]);
    expect(h.atlas.tick().pending).toBe(0);
    expect(h.atlas.lookup("a")).not.toBeNull();
    h.atlas.dispose(); h.atlas.dispose();
    expect(h.atlas.textureBytes()).toBe(0);
    expect(h.atlas.cpuBytes()).toBe(0);
    expect(h.atlas.tick().baked).toBe(0);
  });

  it("앞당겨 받은 그림으로 다음 tick에 여러 카드를 굽고 텍스처는 굽기 때 할당", async () => {
    const h = harness();
    const images = Array.from({ length: 6 }, () => bitmap());
    h.decode.mockImplementation(async (src) => images[Number(src)]);
    h.sync(images.map((_, i) => ({ ...h.request(String(i)), sources: [String(i)] })));
    expect(h.atlas.tick()).toMatchObject({ baked: 0, pending: 6 });
    expect(h.decode).toHaveBeenCalledTimes(6);
    expect(h.uploader.ensurePage).not.toHaveBeenCalled();
    await flush();
    expect(h.atlas.cpuBytes()).toBe(6 * 8 * 8 * 4);
    expect(h.atlas.tick()).toMatchObject({ baked: 6, pending: 0 });
    expect(h.decode).toHaveBeenCalledTimes(6);
    for (const image of images) expect(image.close).toHaveBeenCalledTimes(1);
    expect(h.atlas.cpuBytes()).toBe(0);
    expect(h.atlas.tick()).toEqual({ baked: 0, uploadedPx: 0, pending: 0 });
  });

  it("앞 카드가 디코드 대기여도 준비된 다음 카드를 먼저 굽는다", async () => {
    const h = harness();
    const slow = deferred<ImageBitmap | null>();
    h.decode.mockImplementation((src) => src === "slow" ? slow.promise : Promise.resolve(bitmap()));
    const a = { ...h.request("a"), sources: ["slow"] }, b = { ...h.request("b"), sources: ["fast"] };
    h.sync([a, b]); h.atlas.tick(); await flush();
    expect(h.atlas.tick()).toMatchObject({ baked: 1, pending: 1 });
    expect(h.atlas.lookup("a")).toBeNull();
    expect(h.atlas.lookup("b")).not.toBeNull();
    slow.resolve(bitmap()); await flush();
    expect(h.atlas.tick()).toMatchObject({ baked: 1, pending: 0 });
  });

  it("준비된 카드가 많아도 4ms 굽기·프레임 올리기 예산을 지킨다", async () => {
    const h = harness({ uploadPx: 100 });
    h.sync(["a", "b", "c"].map((id) => ({ ...h.request(id, 5, 5, 3), sources: [id] })));
    h.atlas.tick(); await flush();
    expect(h.atlas.tick()).toMatchObject({ baked: 2, uploadedPx: 50, pending: 1 });
    expect(h.atlas.tick()).toMatchObject({ baked: 1, uploadedPx: 25, pending: 0 });
    const pixels = harness({ uploadPx: 100 });
    pixels.sync(["a", "b"].map((id) => ({ ...pixels.request(id, 8, 8), sources: [id] })));
    pixels.atlas.tick(); await flush();
    expect(pixels.atlas.tick()).toMatchObject({ baked: 1, uploadedPx: 64 });
    expect(pixels.atlas.tick()).toMatchObject({ baked: 1, uploadedPx: 64, pending: 0 });
  });

  it("여러 카드 미리 받기도 디코드 합계는 6 이하, 빈 자리만 채운다", async () => {
    const h = harness();
    const pending = Array.from({ length: 12 }, () => deferred<ImageBitmap | null>());
    h.decode.mockImplementation((src) => pending[Number(src)].promise);
    h.sync(pending.map((_, i) => ({ ...h.request(String(i)), sources: [String(i)] })));
    h.atlas.tick(); h.atlas.tick();
    expect(h.decode).toHaveBeenCalledTimes(6);
    pending[1].resolve(bitmap()); await flush();
    expect(h.atlas.tick().baked).toBe(1);
    expect(h.decode).toHaveBeenCalledTimes(7);
    h.atlas.tick();
    expect(h.decode).toHaveBeenCalledTimes(7);
    h.atlas.dispose();
    pending.forEach((p) => p.resolve(null)); await flush();
  });

  it("미리 받기 대상은 현재 카드와 대기열 앞 8장으로 제한", async () => {
    const h = harness();
    h.sync(Array.from({ length: 20 }, (_, i) => ({ ...h.request(String(i), 4, 4, 5), sources: [String(i)] })));
    h.atlas.tick(); await flush();
    for (let i = 0; i < 3; i++) { expect(h.atlas.tick().baked).toBe(1); await flush(); }
    expect(h.decode.mock.calls.map(([src]) => Number(src))).toEqual(Array.from({ length: 12 }, (_, i) => i));
    h.atlas.dispose();
  });

  it.each(["key", "width", "tier", "remove"])("sync에서 %s 변경은 미리 받은 비트맵을 즉시 닫는다", async (change) => {
    const h = harness();
    const aImage = bitmap(), bImage = bitmap();
    h.decode.mockImplementation(async (src) => src === "a" ? aImage : bImage);
    const a = { ...h.request("a", 40, 20, 5), sources: ["a"] }, b = { ...h.request("b"), sources: ["b"] };
    h.sync([a, b]); h.atlas.tick(); await flush();
    expect(h.atlas.tick().baked).toBe(1);
    expect(bImage.close).not.toHaveBeenCalled();
    h.sync(change === "remove" ? [a] : [a, { ...b, key: change === "key" ? "new" : b.key, w: change === "width" ? 80 : b.w }], change === "tier" ? 2 : 1);
    expect(bImage.close).toHaveBeenCalledTimes(1);
    expect(h.atlas.cpuBytes()).toBe(0);
  });

  it.each(["change", "reset", "dispose"])("%s 뒤 늦은 미리 받기 결과는 버린다", async (action) => {
    const h = harness();
    const late = deferred<ImageBitmap | null>();
    h.decode.mockImplementation((src) => src === "b" ? late.promise : Promise.resolve(null));
    const a = { ...h.request("a"), sources: ["a"] }, b = { ...h.request("b"), sources: ["b"] };
    h.sync([a, b]); h.atlas.tick();
    if (action === "change") h.sync([a, { ...b, key: "new" }]);
    else if (action === "reset") h.atlas.reset(2);
    else h.atlas.dispose();
    const image = bitmap(); late.resolve(image); await flush();
    expect(image.close).toHaveBeenCalledTimes(1);
    expect(h.atlas.lookup("b")).toBeNull();
    expect(h.atlas.cpuBytes()).toBe(0);
    h.atlas.dispose();
  });

  it("CPU 예산 근처에서는 미리 받기만 멈추고 현재 카드부터 계속 처리", async () => {
    const h = harness({ cpuBytes: 128 });
    h.decode.mockImplementation(async () => bitmap(4, 4));
    h.sync(["a", "b", "c"].map((id) => ({ ...h.request(id, 4, 4), sources: [id] })));
    expect(() => h.atlas.tick()).not.toThrow();
    expect(h.decode).toHaveBeenCalledTimes(1);
    await flush();
    expect(h.atlas.cpuBytes()).toBe(64);
    for (let i = 0; i < 3; i++) {
      expect(h.atlas.tick()).toMatchObject({ baked: 1, pending: 2 - i });
      await flush();
      expect(h.atlas.cpuBytes()).toBeLessThanOrEqual(128);
    }
    expect(h.decode).toHaveBeenCalledTimes(3);
  });

  it("예상보다 큰 미리 받기 결과는 닫고 보류하며 throw하지 않는다", async () => {
    const h = harness({ cpuBytes: 1024 });
    const large = bitmap(16, 16);
    h.decode.mockResolvedValueOnce(bitmap(4, 4)).mockResolvedValueOnce(large);
    h.sync(["a", "b"].map((id) => ({ ...h.request(id, 4, 4), sources: [id] })));
    h.atlas.tick(); await flush();
    expect(large.close).toHaveBeenCalledTimes(1);
    expect(h.atlas.cpuBytes()).toBe(64);
    expect(() => h.atlas.tick()).not.toThrow();
    expect(h.atlas.lookup("a")).not.toBeNull();
    await flush();
    expect(h.atlas.tick()).toMatchObject({ baked: 1, pending: 0 });
  });

  it("현재 카드에 필요한 메모리는 미리 받은 그림부터 놓아 확보한다", async () => {
    const h = harness({ cpuBytes: 256 });
    const ahead = bitmap(4, 4);
    h.decode.mockResolvedValueOnce(bitmap(4, 4)).mockResolvedValueOnce(ahead).mockResolvedValueOnce(bitmap(5, 5));
    const a = { ...h.request("a", 4, 4, 5), sources: ["a"] }, b = { ...h.request("b", 4, 4), sources: ["b"] };
    h.sync([a, b]); h.atlas.tick(); await flush(); h.atlas.tick();
    expect(h.atlas.cpuBytes()).toBe(64);
    const c = { ...h.request("c", 5, 4), sources: ["c"] };
    h.sync([c, b]); h.atlas.tick(); await flush();
    expect(ahead.close).toHaveBeenCalledTimes(1);
    expect(h.atlas.cpuBytes()).toBe(100);
    expect(() => h.atlas.tick()).not.toThrow();
    expect(h.atlas.lookup("c")).not.toBeNull();
    h.atlas.dispose();
  });

  it("현재 카드의 모든 원본도 디코드 전 폭·높이와 동시 예약량을 제한한다", async () => {
    const h = harness({ cpuBytes: 256 });
    let reserved = 0, peakReserved = 0;
    const pending = Array.from({ length: 8 }, () => deferred<ImageBitmap | null>());
    h.decode.mockImplementation((src, width, height) => {
      const bytes = width * height * 4;
      reserved += bytes; peakReserved = Math.max(peakReserved, reserved + h.atlas.cpuBytes());
      return pending[Number(src)].promise.then((image) => { reserved -= bytes; return image; });
    });
    h.sync([{ ...h.request("a", 4, 4), sources: pending.map((_, i) => String(i)) }]);
    h.atlas.tick();
    expect(h.decode).toHaveBeenCalledTimes(6);
    expect(h.decode.mock.calls.every(([, w, height]) => w === 2 && height === 2)).toBe(true);
    pending.slice(0, 6).forEach((p) => p.resolve(bitmap(2, 2))); await flush();
    h.atlas.tick();
    expect(h.decode).toHaveBeenCalledTimes(8);
    pending.slice(6).forEach((p) => p.resolve(bitmap(2, 2))); await flush();
    expect(h.atlas.tick().pending).toBe(0);
    expect(peakReserved).toBeLessThanOrEqual(128);
    expect(h.atlas.cpuPeak()).toBe(192);
  });

  it("세로로 긴 원본은 높이 상한 안에서 디코드하고 즉시 놓은 비트맵도 최고점에 기록", async () => {
    const h = harness();
    h.decode.mockImplementation(async (_src, width, height) => bitmap(Math.min(width, 1), height));
    h.sync([{ ...h.request("a", 100, 3000), sources: ["1x100000000"] }]);
    h.atlas.tick(); await flush();
    expect(h.decode).toHaveBeenCalledWith("1x100000000", 100, 100);
    expect(h.atlas.cpuPeak()).toBe(400);
    h.atlas.dispose();
    expect(h.atlas.cpuBytes()).toBe(0);
    expect(h.atlas.cpuPeak()).toBe(400);
  });

  it("취소한 디코드의 예약량은 도착 전까지 남기고 새 작업은 그 뒤에 진행한다", async () => {
    const h = harness({ cpuBytes: 128 });
    const pending = deferred<ImageBitmap | null>();
    h.decode.mockReturnValueOnce(pending.promise).mockResolvedValue(bitmap(4, 4));
    const a = { ...h.request("a", 4, 4), sources: ["a"] }, b = { ...h.request("b", 4, 4), sources: ["b"] };
    h.sync([a]); h.atlas.tick();
    h.sync([b], 1, ["b"], 2); h.atlas.tick();
    expect(h.decode).toHaveBeenCalledTimes(1);
    pending.resolve(bitmap(4, 4)); await flush();
    expect(h.atlas.cpuPeak()).toBe(64);
    h.atlas.tick(); await flush();
    expect(h.atlas.tick().pending).toBe(0);
    expect(h.atlas.cpuPeak()).toBe(128);
  });

  it("높이 3000px 카드 두 장을 2배 띠로 구워도 직사각형 장으로 예산 안에 든다", () => {
    const h = harness();
    h.sync([h.request("a", 400, 3000), h.request("b", 400, 3000)], 2);
    let pending = 2;
    for (let i = 0; i < 10 && pending; i++) {
      const tick = h.atlas.tick(); pending = tick.pending;
      expect(tick.uploadedPx).toBeLessThanOrEqual(4 * 1024 * 1024);
    }
    expect(pending).toBe(0);
    expect(h.atlas.lookup("a")?.tier).toBe(2);
    expect(h.atlas.lookup("b")?.tier).toBe(2);
    expect([...h.pages.values()]).toEqual([{ width: 1024, height: 8192 }, { width: 1024, height: 8192 }]);
    expect(h.atlas.textureBytes()).toBe(64 * 1024 * 1024);
    expect(h.atlas.cpuPeak()).toBeLessThanOrEqual(64 * 1024 * 1024);
    expect(h.atlas.lookup("b")?.v1).toBe((6000 - 0.5) / 8192);
  });

  it.each(["reset", "dispose"])("%s는 이미 준비된 미리 받기 비트맵도 전부 닫는다", async (action) => {
    const h = harness();
    const images = [bitmap(), bitmap(), bitmap()];
    h.decode.mockImplementation(async (src) => images[Number(src)]);
    h.sync(images.map((_, i) => ({ ...h.request(String(i)), sources: [String(i)] })));
    h.atlas.tick(); await flush();
    expect(h.atlas.cpuBytes()).toBe(3 * 8 * 8 * 4);
    if (action === "reset") h.atlas.reset(2);
    else h.atlas.dispose();
    for (const image of images) expect(image.close).toHaveBeenCalledTimes(1);
    expect(h.atlas.cpuBytes()).toBe(0);
    expect(h.atlas.tick()).toEqual({ baked: 0, uploadedPx: 0, pending: 0 });
  });
});

function fakeGl(options: { compile?: boolean; link?: boolean; timer?: boolean } = {}) {
  let constant = 1;
  const values: Record<string, unknown> = {};
  const calls = new Map<string, ReturnType<typeof vi.fn>>();
  const loseContext = vi.fn(() => canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true })));
  const gl = new Proxy(values, {
    get(target, key: string) {
      if (key in target) return target[key];
      if (/^[A-Z0-9_]+$/.test(key)) { target[key] = constant++; return target[key]; }
      const fn = vi.fn((...args: unknown[]) => {
        if (key.startsWith("create") || key === "getUniformLocation") return {};
        if (key === "getShaderParameter") return options.compile !== false;
        if (key === "getProgramParameter") return options.link !== false;
        if (key === "getParameter") return args[0] === gl.MAX_TEXTURE_SIZE ? 8192 : false;
        if (key === "getExtension") return args[0] === "WEBGL_lose_context" ? { loseContext }
          : options.timer ? { TIME_ELAPSED_EXT: 900, GPU_DISJOINT_EXT: 901 } : null;
        if (key === "getQueryParameter") return args[1] === gl.QUERY_RESULT_AVAILABLE ? true : 2e6;
        if (key === "getError") return gl.NO_ERROR;
        return undefined;
      });
      calls.set(key, fn); target[key] = fn;
      return fn;
    },
  }) as unknown as WebGL2RenderingContext;
  const canvas = document.createElement("canvas");
  vi.spyOn(canvas, "getContext").mockReturnValue(gl);
  return { gl, canvas, loseContext, call: (name: string) => calls.get(name)! };
}
const camera = { z: 1, x: 0, y: 0, dpr: 2, width: 800, height: 600 };
const scene = (): GpuScene => ({
  cards: [{ id: "a", x: 0, y: 0, w: 40, h: 20, z: 1, radius: 4, border: [1, 0, 0, 1], borderWidth: 1, hidden: false }],
  lines: [{ points: new Float32Array([0, 0, 10, 10, 20, 10]), color: [1, 1, 1, 1], width: 2, dash: 4 }],
  rects: [], dots: [], quads: [],
});

describe("gpuRenderer (기록하는 GL)", () => {
  it.each([{ compile: false }, { link: false }])("셰이더 실패는 null, 만든 자원 해제 %s", (options) => {
    const h = fakeGl(options);
    expect(createGpuRenderer(h.canvas)).toBeNull();
    expect(h.call("deleteProgram")).toHaveBeenCalled();
    expect(h.call("deleteShader")).toHaveBeenCalled();
  });

  it("WebGL2 없음·생성 예외는 null", () => {
    const canvas = document.createElement("canvas");
    const get = vi.spyOn(canvas, "getContext").mockReturnValue(null);
    expect(createGpuRenderer(canvas)).toBeNull();
    get.mockImplementation(() => { throw new Error("unavailable"); });
    expect(createGpuRenderer(canvas)).toBeNull();
  });

  it("카메라만 바꾸면 버퍼 업로드 0, 새 UV가 오면 그 영역만 갱신", () => {
    const h = fakeGl();
    const renderer = createGpuRenderer(h.canvas)!;
    renderer.setScene(scene());
    renderer.ensurePage(1, 64);
    const region = { page: 1, u0: 0, v0: 0, u1: 0.5, v1: 0.5, tier: 1 };
    renderer.draw(camera, () => region);
    expect(h.canvas.width).toBe(1600); expect(h.canvas.height).toBe(1200);
    h.call("bufferData").mockClear(); h.call("bufferSubData").mockClear();
    renderer.draw({ ...camera, z: 0.5, x: 100, y: -50 }, () => ({ ...region }));
    expect(h.call("bufferData")).not.toHaveBeenCalled();
    expect(h.call("bufferSubData")).not.toHaveBeenCalled();
    renderer.draw(camera, () => ({ ...region, u1: 0.75 }));
    expect(h.call("bufferSubData")).toHaveBeenCalledTimes(1);
    expect(h.call("drawArraysInstanced")).toHaveBeenCalled();
    renderer.destroy();
    expect(renderer.textureBytes()).toBe(0);
    expect(h.call("deleteBuffer")).toHaveBeenCalledTimes(4);
    expect(h.call("deleteVertexArray")).toHaveBeenCalledTimes(3);
  });

  it("setHidden — 덧판 카드 한 장만 크기 0 으로 감추고 되살린다(버퍼 전체 다시 올림 없음)", () => {
    const h = fakeGl();
    const renderer = createGpuRenderer(h.canvas)!;
    const s = scene();
    s.cards.push({ ...s.cards[0], id: "b", x: 50, w: 30, h: 15, z: 2 });
    renderer.setScene(s);
    void h.gl.bufferSubData; // 기록 함수는 처음 읽을 때 생긴다
    h.call("bufferData").mockClear(); h.call("bufferSubData").mockClear();
    renderer.setHidden("b");
    expect(h.call("bufferData")).not.toHaveBeenCalled();
    const sub = h.call("bufferSubData");
    expect(sub).toHaveBeenCalledTimes(1);
    expect(sub.mock.calls[0][1]).toBe((1 * 15 + 2) * 4); // 카드 칸 1(b)의 w·h 자리
    expect([...(sub.mock.calls[0][2] as Float32Array)]).toEqual([0, 0]);
    sub.mockClear();
    renderer.setHidden("b"); // 같은 카드면 아무것도 안 함
    expect(sub).not.toHaveBeenCalled();
    renderer.setHidden(null);
    expect(sub).toHaveBeenCalledTimes(1);
    expect([...(sub.mock.calls[0][2] as Float32Array)]).toEqual([30, 15]); // 원래 크기로 되살림
  });

  it("숨긴 카드 제외, 그룹·그룹 이름표→선→카드→포트 순서", () => {
    const h = fakeGl();
    const renderer = createGpuRenderer(h.canvas)!;
    const s = scene();
    s.cards.push({ ...s.cards[0], id: "hidden", hidden: true });
    s.rects.push({ x: 0, y: 0, w: 40, h: 40, radius: 2, borderWidth: 1, fill: [0, 0, 0, 0], border: [1, 1, 1, 1] });
    s.dots.push({ x: 10, y: 10, r: 3, fill: [1, 1, 1, 1], border: [0, 0, 0, 1] });
    s.quads.push({ id: "label", x: 0, y: 0, w: 20, h: 10 });
    renderer.setScene(s);
    const lookup = vi.fn((_id: string) => null);
    renderer.draw(camera, lookup);
    expect(lookup.mock.calls.map((c) => c[0])).toEqual(["label", "a"]);
    const shapeOrders = h.call("drawArraysInstanced").mock.invocationCallOrder;
    const lineOrder = h.call("drawArrays").mock.invocationCallOrder[1];
    expect(shapeOrders).toHaveLength(3);
    expect(shapeOrders[0]).toBeLessThan(lineOrder);
    expect(lineOrder).toBeLessThan(shapeOrders[1]);
  });

  it("컨텍스트 상실은 한 번 알리고 복구 이벤트 뒤에도 draw 금지", () => {
    const h = fakeGl();
    const onContextLost = vi.fn();
    const renderer = createGpuRenderer(h.canvas, { onContextLost })!;
    renderer.setScene(scene());
    const event = new Event("webglcontextlost", { cancelable: true });
    h.canvas.dispatchEvent(event);
    h.canvas.dispatchEvent(new Event("webglcontextlost"));
    h.canvas.dispatchEvent(new Event("webglcontextrestored"));
    expect(event.defaultPrevented).toBe(true);
    expect(onContextLost).toHaveBeenCalledTimes(1);
    expect(renderer.lost()).toBe(true);
    renderer.draw(camera, () => null);
    expect(h.call("drawArrays")).toBeUndefined();
    renderer.destroy(); renderer.destroy();
    expect(h.call("deleteProgram")).toHaveBeenCalledTimes(3);
  });

  it("destroy는 상실 듣기를 먼저 떼고 컨텍스트를 한 번 놓는다", () => {
    const h = fakeGl();
    const onContextLost = vi.fn();
    const renderer = createGpuRenderer(h.canvas, { onContextLost })!;
    renderer.destroy(); renderer.destroy();
    expect(h.loseContext).toHaveBeenCalledTimes(1);
    expect(onContextLost).not.toHaveBeenCalled();
    expect(renderer.lost()).toBe(false);
  });

  it("owner 조각은 해당 카드 바로 뒤에 들어가고 숨김·복원도 함께 한다", () => {
    const h = fakeGl();
    const renderer = createGpuRenderer(h.canvas)!;
    const s = scene();
    s.cards.push({ ...s.cards[0], id: "b", x: 20, z: 2 }, { ...s.cards[0], id: "hidden", hidden: true });
    s.rects.push({ owner: "a", x: 11, y: 0, w: 30, h: 20, radius: 0, borderWidth: 1, fill: [0, 0, 0, 0], border: [1, 1, 1, 1] });
    s.selection = [{ ...s.rects[0], owner: "b", x: 21 }];
    s.quads.push(
      { id: "group", x: -10, y: 0, w: 20, h: 10 },
      { id: "badge-b", owner: "b", x: 22, y: 0, w: 20, h: 10 },
      { id: "badge-a", owner: "a", x: 12, y: 0, w: 20, h: 10, hideLow: true },
      { id: "badge-hidden", owner: "hidden", x: 99, y: 0, w: 20, h: 10 },
    );
    renderer.setScene(s);
    const data = h.call("bufferData").mock.calls[1][1] as Float32Array;
    expect(Array.from({ length: data.length / 15 }, (_, i) => data[i * 15])).toEqual([-10, 0, 11, 12, 20, 21, 22]);
    expect(data[3 * 15 + 6]).toBe(1);
    renderer.draw(camera, () => null);
    const orders = h.call("drawArraysInstanced").mock.invocationCallOrder;
    expect(orders[0]).toBeLessThan(h.call("drawArrays").mock.invocationCallOrder[1]);
    expect(h.call("drawArrays").mock.invocationCallOrder[1]).toBeLessThan(orders[1]);
    h.call("bufferSubData").mockClear(); h.call("bufferData").mockClear();
    renderer.setHidden("a");
    expect(h.call("bufferSubData").mock.calls.map((c) => c[1])).toEqual([1, 2, 3].map((i) => (i * 15 + 2) * 4));
    expect(h.call("bufferSubData").mock.calls.map((c) => [...c[2] as Float32Array])).toEqual([[0, 0], [0, 0], [0, 0]]);
    h.call("bufferSubData").mockClear();
    renderer.setHidden(null);
    expect(h.call("bufferSubData").mock.calls.map((c) => [...c[2] as Float32Array])).toEqual([[40, 20], [30, 20], [20, 10]]);
    h.call("bufferSubData").mockClear();
    renderer.setLowLod(true); renderer.draw(camera, () => null);
    expect(h.call("bufferSubData")).not.toHaveBeenCalled();
    expect(h.call("bufferData")).not.toHaveBeenCalled();
  });

  it("카드 500장·선택·서로 다른 장의 배지도 한 묶음으로 그리고 카메라 이동은 재업로드하지 않는다", () => {
    const h = fakeGl();
    const renderer = createGpuRenderer(h.canvas)!;
    const s = scene(); s.cards = []; s.lines = [];
    for (let i = 0; i < 500; i++) {
      const id = `c${i}`;
      s.cards.push({ ...scene().cards[0], id, z: i });
      s.rects.push({ owner: id, x: 0, y: 0, w: 40, h: 20, radius: 2, fill: [0, 0, 0, 0], border: [1, 1, 1, 1], borderWidth: 1 });
      s.quads.push({ owner: id, id: `badge${i}`, x: 0, y: 0, w: 10, h: 10 });
    }
    renderer.setScene(s);
    renderer.ensurePage(1, 64); renderer.ensurePage(2, 64);
    const lookup = (id: string) => ({ page: id.startsWith("badge") ? 2 : 1, u0: 0, v0: 0, u1: 1, v1: 1, tier: 1 });
    renderer.draw(camera, lookup);
    expect(h.call("drawArraysInstanced").mock.calls.map((c) => c[3])).toEqual([1500]);
    const uv = h.call("bufferSubData").mock.calls[0][2] as Float32Array;
    expect([uv[4], uv[9], uv[14], uv[19]]).toEqual([0, -1, 1, 0]);
    h.call("bufferData").mockClear(); h.call("bufferSubData").mockClear(); h.call("drawArraysInstanced").mockClear();
    renderer.draw({ ...camera, x: 10 }, lookup);
    expect(h.call("drawArraysInstanced")).toHaveBeenCalledTimes(1);
    expect(h.call("bufferSubData")).not.toHaveBeenCalled();
    expect(h.call("bufferData")).not.toHaveBeenCalled();
  });

  it("텍스처는 밉맵 없이 할당 크기로 세고 128MiB 초과 전에 거절", () => {
    const h = fakeGl();
    const renderer = createGpuRenderer(h.canvas)!;
    renderer.ensurePage(0, 4096); renderer.ensurePage(1, 4096);
    expect(renderer.textureBytes()).toBe(128 * 1024 * 1024);
    expect(() => renderer.ensurePage(2, 1)).toThrow(/budget/);
    expect(h.call("texStorage2D").mock.calls.every((c) => c[1] === 1)).toBe(true);
    renderer.deletePage(0);
    expect(renderer.textureBytes()).toBe(64 * 1024 * 1024);
    expect(renderer.texturePeak()).toBe(128 * 1024 * 1024);
    renderer.destroy();
    expect(renderer.textureBytes()).toBe(0);
    expect(renderer.texturePeak()).toBe(128 * 1024 * 1024);
  });

  it("텍스처 8장 경계에서만 묶음을 나누고 순서·슬롯을 유지한다", () => {
    const h = fakeGl();
    const renderer = createGpuRenderer(h.canvas)!;
    const s = scene(); s.lines = [];
    s.cards = Array.from({ length: 10 }, (_, i) => ({ ...s.cards[0], id: String(i), z: i }));
    renderer.setScene(s);
    for (let i = 0; i < 10; i++) renderer.ensurePage(i, 16);
    renderer.draw(camera, (id) => ({ page: Number(id), u0: 0, v0: 0, u1: 1, v1: 1, tier: 1 }));
    expect(h.call("drawArraysInstanced").mock.calls.map((c) => c[3])).toEqual([8, 2]);
    const uv = h.call("bufferSubData").mock.calls[0][2] as Float32Array;
    expect(Array.from({ length: 10 }, (_, i) => uv[i * 5 + 4])).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 0, 1]);
  });

  it("직사각형 텍스처의 할당·올리기 경계는 폭과 높이를 따로 쓴다", () => {
    const h = fakeGl();
    const renderer = createGpuRenderer(h.canvas)!;
    renderer.ensurePage(0, 1024, 8192);
    expect(renderer.textureBytes()).toBe(32 * 1024 * 1024);
    expect(h.call("texStorage2D").mock.calls[0].slice(-2)).toEqual([1024, 8192]);
    const canvas = document.createElement("canvas"); canvas.width = 10; canvas.height = 10;
    expect(() => renderer.upload(0, 0, 6000, canvas, 10, 10)).not.toThrow();
    expect(() => renderer.upload(0, 1020, 0, canvas, 10, 10)).toThrow(/upload/);
    expect(() => renderer.ensurePage(0, 8192, 1024)).toThrow(/size changed/);
    expect(() => renderer.ensurePage(1, 1, 8193)).toThrow(/size unsupported/);
  });

  it.each([false, true])("GPU 측정 timer=%s, 요청한 프레임 수만큼 결과 반환", async (timer) => {
    const callbacks = new Map<number, FrameRequestCallback>();
    let id = 0;
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => { callbacks.set(++id, fn); return id; });
    vi.stubGlobal("cancelAnimationFrame", (n: number) => callbacks.delete(n));
    const h = fakeGl({ timer });
    const renderer = createGpuRenderer(h.canvas)!;
    renderer.setScene(scene()); renderer.draw(camera, () => null);
    const result = renderer.timeGpu(30);
    for (let i = 0; i < 40 && callbacks.size; i++) {
      const [key, fn] = [...callbacks][0]; callbacks.delete(key); fn(i * 16);
    }
    const times = await result;
    expect(times).toHaveLength(30);
    expect(times.every(Number.isFinite)).toBe(true);
    if (timer) expect(times).toEqual(Array(30).fill(2));
    else expect(h.call("finish")).toHaveBeenCalledTimes(60);
    expect(callbacks.size).toBe(0);
  });

  it.each(["disjoint", "timeout"])("한 번 난 %s 표본은 버리고 다시 재어 30개를 채운다(그 한 번으로 잠그지 않는다)", async (failure) => {
    const callbacks = new Map<number, FrameRequestCallback>();
    let id = 0, clock = 0;
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => { callbacks.set(++id, fn); return id; });
    vi.stubGlobal("cancelAnimationFrame", (n: number) => callbacks.delete(n));
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const h = fakeGl({ timer: true });
    const renderer = createGpuRenderer(h.canvas)!;
    renderer.setScene(scene()); renderer.draw(camera, () => null);
    const result = renderer.timeGpu(30);
    const step = () => { const [key, fn] = [...callbacks][0]; callbacks.delete(key); fn(clock); };
    step(); step(); step();
    if (failure === "disjoint") h.call("getParameter").mockImplementationOnce((key) => key === 901);
    if (failure === "timeout") { h.call("getQueryParameter").mockImplementationOnce(() => false); clock += 1001; }
    for (let i = 0; i < 80 && callbacks.size; i++) step();
    const times = await result;
    expect(times).toHaveLength(30);
    expect(times.every(Number.isFinite)).toBe(true);
    expect(h.call("deleteQuery")).toHaveBeenCalledTimes(h.call("createQuery").mock.calls.length);
  });

  it.each(["disjoint", "timeout", "nonfinite", "destroy", "lost", "draw"])("정상 표본 2개 뒤 %s가 계속되면(disjoint·timeout 은 버린 것이 요청 수를 넘으면) 부분 배열 대신 거부하고 질의를 해제한다", async (failure) => {
    const callbacks = new Map<number, FrameRequestCallback>();
    let id = 0, clock = 0;
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => { callbacks.set(++id, fn); return id; });
    vi.stubGlobal("cancelAnimationFrame", (n: number) => callbacks.delete(n));
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const h = fakeGl({ timer: true });
    const renderer = createGpuRenderer(h.canvas)!;
    renderer.setScene(scene()); renderer.draw(camera, () => null);
    const result = renderer.timeGpu(30);
    const rejected = expect(result).rejects.toThrow();
    const step = () => { const [key, fn] = [...callbacks][0]; callbacks.delete(key); fn(clock); };
    step(); step(); step();
    if (failure === "disjoint") h.call("getParameter").mockImplementation((key) => key === 901);
    if (failure === "timeout") { h.call("getQueryParameter").mockReturnValue(false); clock = 1001; }
    if (failure === "nonfinite") h.call("getQueryParameter").mockImplementation((_, key) => key === h.gl.QUERY_RESULT_AVAILABLE ? true : Infinity);
    if (failure === "destroy") renderer.destroy();
    else if (failure === "lost") h.canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    else {
      if (failure === "draw") vi.spyOn(renderer, "draw").mockImplementation(() => { throw new Error("draw failed"); });
      // disjoint·timeout 은 버리고 다시 재므로, 계속되면 버린 것이 30개를 넘을 때 거부한다(timeout 은 걸음마다 1초 넘게 흐른다)
      for (let i = 0; i < 200 && callbacks.size; i++) {
        if (failure === "timeout") clock += 1001;
        step();
      }
    }
    await rejected;
    expect(callbacks.size).toBe(0);
    expect(h.call("deleteQuery")).toHaveBeenCalledTimes(h.call("createQuery").mock.calls.length);
  });

  it("앞 검사가 도는 중 새 검사가 오면(씬 전환) 앞 것을 취소하고 새로 잰다 — 새 검사를 거부해 잠그지 않는다", async () => {
    const callbacks = new Map<number, FrameRequestCallback>();
    let id = 0;
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => { callbacks.set(++id, fn); return id; });
    vi.stubGlobal("cancelAnimationFrame", (n: number) => callbacks.delete(n));
    const h = fakeGl({ timer: true });
    const renderer = createGpuRenderer(h.canvas)!;
    renderer.setScene(scene()); renderer.draw(camera, () => null);
    const first = renderer.timeGpu(30);
    const firstDone = expect(first).rejects.toThrow(/cancelled/);
    const second = renderer.timeGpu(30);
    for (let i = 0; i < 80 && callbacks.size; i++) { const [key, fn] = [...callbacks][0]; callbacks.delete(key); fn(i * 16); }
    await firstDone;
    expect(await second).toHaveLength(30);
  });

  it("질의를 낸 지 1초가 넘어 결과가 온 표본은 버리고 다시 잰다 — 늦은 값(7ms)이 표본에 섞이지 않는다", async () => {
    const callbacks = new Map<number, FrameRequestCallback>();
    let id = 0, clock = 0;
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => { callbacks.set(++id, fn); return id; });
    vi.stubGlobal("cancelAnimationFrame", (n: number) => callbacks.delete(n));
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const h = fakeGl({ timer: true });
    const renderer = createGpuRenderer(h.canvas)!;
    renderer.setScene(scene()); renderer.draw(camera, () => null);
    const result = renderer.timeGpu(30);
    const step = () => { const [key, fn] = [...callbacks][0]; callbacks.delete(key); fn(clock); };
    step(); step(); step();
    const base = h.call("getQueryParameter").getMockImplementation()!;
    clock += 1100; // 이번 질의는 1.1초 뒤에야 결과가 왔다
    h.call("getQueryParameter").mockImplementationOnce((q: unknown, key: unknown) => (key === h.gl.QUERY_RESULT_AVAILABLE ? true : base(q, key)))
      .mockImplementationOnce(() => 7e6);
    for (let i = 0; i < 80 && callbacks.size; i++) step();
    const times = await result;
    expect(times).toHaveLength(30);
    expect(times).not.toContain(7);
  });

  it("유효 표본이 늦게(질의마다 1초 가까이) 와도 전체 10초가 지나면 거부한다(느린 GPU)", async () => {
    const callbacks = new Map<number, FrameRequestCallback>();
    let id = 0, clock = 0;
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => { callbacks.set(++id, fn); return id; });
    vi.stubGlobal("cancelAnimationFrame", (n: number) => callbacks.delete(n));
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const h = fakeGl({ timer: true });
    const renderer = createGpuRenderer(h.canvas)!;
    renderer.setScene(scene()); renderer.draw(camera, () => null);
    const result = renderer.timeGpu(30);
    const rejected = expect(result).rejects.toThrow(/too slow/);
    for (let i = 0; i < 100 && callbacks.size; i++) { clock += 900; const [key, fn] = [...callbacks][0]; callbacks.delete(key); fn(clock); }
    await rejected;
  });

  it("측정할 프레임 수·그림이 유효하지 않으면 거부한다", async () => {
    const h = fakeGl();
    const renderer = createGpuRenderer(h.canvas)!;
    await expect(renderer.timeGpu(30)).rejects.toThrow();
    renderer.setScene(scene()); renderer.draw(camera, () => null);
    for (const frames of [0, -1, 1.5, NaN, Infinity]) await expect(renderer.timeGpu(frames)).rejects.toThrow();
    renderer.destroy();
    await expect(renderer.timeGpu(30)).rejects.toThrow();
  });

  it("타이머 대체 측정도 유한하지 않은 벽시계 표본이면 거부한다", async () => {
    const callbacks: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => { callbacks.push(fn); return 1; });
    vi.stubGlobal("cancelAnimationFrame", () => { callbacks.length = 0; });
    const h = fakeGl();
    const renderer = createGpuRenderer(h.canvas)!;
    renderer.setScene(scene()); renderer.draw(camera, () => null);
    vi.spyOn(performance, "now").mockReturnValue(NaN);
    const result = renderer.timeGpu(30);
    const rejected = expect(result).rejects.toThrow(/samples/);
    callbacks.shift()!(0); callbacks.shift()!(16);
    await rejected;
    expect(callbacks).toHaveLength(0);
  });
});
