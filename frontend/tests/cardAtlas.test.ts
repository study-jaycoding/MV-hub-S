// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCardAtlas, type AtlasBudgets, type AtlasRequest, type AtlasUploader } from "../src/features/canvas/gpu/cardAtlas";
import { createGpuRenderer, type GpuScene } from "../src/features/canvas/gpu/gpuRenderer";

function harness(budgets: Partial<AtlasBudgets> = {}) {
  let clock = 0;
  const pages = new Map<number, number>();
  const events: string[] = [];
  const g = { save: vi.fn(), restore: vi.fn(), setTransform: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn() };
  const canvases: Array<{ width: number; height: number }> = [];
  const uploader: AtlasUploader = {
    ensurePage: vi.fn((id, size) => { pages.set(id, size); events.push(`add:${id}`); }),
    upload: vi.fn((page) => { events.push(`upload:${page}`); }),
    deletePage: vi.fn((id) => { pages.delete(id); events.push(`delete:${id}`); }),
  };
  const decode = vi.fn<(...args: [string, number]) => Promise<ImageBitmap | null>>().mockResolvedValue(null);
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
    expect(h.atlas.textureBytes()).toBe(before + 4096 * 4096 * 4);
    expect(h.atlas.textureBytes()).toBeLessThanOrEqual(128 * 1024 * 1024);
    expect(h.atlas.tick().pending).toBe(0);
    expect(h.atlas.textureBytes()).toBe(4096 * 4096 * 4);
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
    expect(h.decode).toHaveBeenCalledWith("src0", 40);
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
    expect(() => h.atlas.tick()).toThrow(/CPU budget/);
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
    const current = deferred<ImageBitmap | null>(), next = deferred<ImageBitmap | null>();
    h.decode.mockReturnValueOnce(current.promise).mockReturnValueOnce(next.promise);
    h.sync(["a", "b"].map((id) => ({ ...h.request(id, 4, 4), sources: [id] })));
    h.atlas.tick();
    const ahead = bitmap(4, 4);
    next.resolve(ahead); await flush();
    expect(h.atlas.cpuBytes()).toBe(64);
    current.resolve(bitmap(4, 10)); await flush();
    expect(ahead.close).toHaveBeenCalledTimes(1);
    expect(h.atlas.cpuBytes()).toBe(160);
    expect(() => h.atlas.tick()).not.toThrow();
    expect(h.atlas.lookup("a")).not.toBeNull();
    h.atlas.dispose();
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
  const gl = new Proxy(values, {
    get(target, key: string) {
      if (key in target) return target[key];
      if (/^[A-Z0-9_]+$/.test(key)) { target[key] = constant++; return target[key]; }
      const fn = vi.fn((...args: unknown[]) => {
        if (key.startsWith("create") || key === "getUniformLocation") return {};
        if (key === "getShaderParameter") return options.compile !== false;
        if (key === "getProgramParameter") return options.link !== false;
        if (key === "getParameter") return args[0] === gl.MAX_TEXTURE_SIZE ? 8192 : false;
        if (key === "getExtension") return options.timer ? { TIME_ELAPSED_EXT: 900, GPU_DISJOINT_EXT: 901 } : null;
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
  return { gl, canvas, call: (name: string) => calls.get(name)! };
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

  it("숨긴 카드 제외, 그룹→선→카드→포트→이름표 순서", () => {
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
    expect(lookup.mock.calls.map((c) => c[0])).toEqual(["a", "label"]);
    const shapeOrders = h.call("drawArraysInstanced").mock.invocationCallOrder;
    const lineOrder = h.call("drawArrays").mock.invocationCallOrder[1];
    expect(shapeOrders).toHaveLength(4);
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

  it("텍스처는 밉맵 없이 할당 크기로 세고 128MiB 초과 전에 거절", () => {
    const h = fakeGl();
    const renderer = createGpuRenderer(h.canvas)!;
    renderer.ensurePage(0, 4096); renderer.ensurePage(1, 4096);
    expect(renderer.textureBytes()).toBe(128 * 1024 * 1024);
    expect(() => renderer.ensurePage(2, 1)).toThrow(/budget/);
    expect(h.call("texStorage2D").mock.calls.every((c) => c[1] === 1)).toBe(true);
    renderer.deletePage(0);
    expect(renderer.textureBytes()).toBe(64 * 1024 * 1024);
  });

  it.each([false, true])("GPU 측정 timer=%s, 요청한 프레임 수만큼 결과 반환", async (timer) => {
    const callbacks = new Map<number, FrameRequestCallback>();
    let id = 0;
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => { callbacks.set(++id, fn); return id; });
    vi.stubGlobal("cancelAnimationFrame", (n: number) => callbacks.delete(n));
    const h = fakeGl({ timer });
    const renderer = createGpuRenderer(h.canvas)!;
    renderer.setScene(scene()); renderer.draw(camera, () => null);
    const result = renderer.timeGpu(3);
    for (let i = 0; i < 10 && callbacks.size; i++) {
      const [key, fn] = [...callbacks][0]; callbacks.delete(key); fn(i * 16);
    }
    const times = await result;
    expect(times).toHaveLength(3);
    if (timer) expect(times).toEqual([2, 2, 2]);
    else expect(h.call("finish")).toHaveBeenCalledTimes(6);
    expect(callbacks.size).toBe(0);
  });
});
