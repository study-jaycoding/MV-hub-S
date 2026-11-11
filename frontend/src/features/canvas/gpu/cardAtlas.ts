export interface AtlasRequest {
  id: string;
  key: string;
  w: number;
  h: number;
  sources: string[];
  draw: (g: CanvasRenderingContext2D, imageOf: (src: string) => CanvasImageSource | null) => void;
}

export interface AtlasUploader {
  ensurePage(page: number, width: number, height?: number): void;
  upload(page: number, x: number, y: number, source: HTMLCanvasElement | OffscreenCanvas, w: number, h: number): void;
  deletePage(page: number): void;
}

export interface AtlasBudgets {
  textureBytes: number;
  cpuBytes: number;
  bakeMs: number;
  uploadPx: number;
  decodes: number;
  pageSize: number;
}

export interface AtlasRegion {
  page: number;
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  tier: number;
}

export interface CardAtlas {
  sync(reqs: AtlasRequest[], visibleIds: ReadonlySet<string>, screenScale: number, generation: number): void;
  tick(): { baked: number; uploadedPx: number; pending: number };
  lookup(id: string): AtlasRegion | null;
  textureBytes(): number;
  cpuBytes(): number;
  cpuPeak(): number;
  reset(generation: number): void;
  dispose(): void;
}

type Box = { x: number; y: number; w: number; h: number };
type Page = { id: number; width: number; height: number; free: Box[]; used: number };
type Slot = Box & { page: Page };
type Entry = { key: string; w: number; h: number; tier: number; slot: Slot; region: AtlasRegion };
type Job = {
  req: AtlasRequest; tier: number; slot: Slot | null; row: number; cancelled: boolean; generation: number;
  images: Map<string, ImageBitmap | null>; sources: string[]; next: number; loading: number;
};

const MiB = 1024 * 1024;
const defaults: AtlasBudgets = {
  textureBytes: 128 * MiB, cpuBytes: 64 * MiB, bakeMs: 4,
  uploadPx: 4 * 1024 * 1024, decodes: 6, pageSize: 1024,
};

export function createCardAtlas(deps: {
  uploader: AtlasUploader;
  now: () => number;
  makeCanvas: (w: number, h: number) => HTMLCanvasElement | OffscreenCanvas;
  // 디코더는 원본 비트맵을 먼저 만들지 않고 두 상한 안으로 디코드해야 예약량이 실제 할당을 보장한다.
  decode: (src: string, resizeWidth: number, resizeHeight: number) => Promise<ImageBitmap | null>;
  budgets?: Partial<AtlasBudgets>;
}): CardAtlas {
  const budget = { ...defaults, ...deps.budgets };
  for (const name of Object.keys(defaults) as Array<keyof AtlasBudgets>) {
    if (!Number.isFinite(budget[name]) || budget[name] <= 0) throw new RangeError(`Invalid atlas budget: ${name}`);
    budget[name] = Math.min(defaults[name], budget[name]);
  }
  budget.decodes = Math.max(1, Math.floor(budget.decodes));
  budget.uploadPx = Math.max(1, Math.floor(budget.uploadPx));
  const pages = new Map<number, Page>();
  const entries = new Map<string, Entry>();
  const evicted = new Set<string>();
  const prepared = new Map<string, Job>();
  const prefetchBlocked = new Set<string>();
  let requests: AtlasRequest[] = [];
  let visible: ReadonlySet<string> = new Set();
  let scale = 1;
  let generation = 0;
  let pageId = 0;
  let disposed = false;
  let job: Job | null = null;
  let decodeCount = 0;
  let decodeReservedBytes = 0;
  let bitmapBytes = 0;
  let canvasBytes = 0;
  let cpuPeakBytes = 0;
  const recordCpuPeak = (incoming = 0) => { cpuPeakBytes = Math.max(cpuPeakBytes, bitmapBytes + canvasBytes + incoming); };
  let failure: Error | null = null;
  // 할 일이 없다고 확인한 뒤 sync 가 오기 전까지는 tick 이 요청 전체를 다시 훑지 않는다(조작 중 매 프레임 불린다)
  let settled = false;

  const textureBytes = () => [...pages.values()].reduce((n, p) => n + p.width * p.height * 4, 0);
  const pixels = (r: AtlasRequest, tier: number) => ({ w: Math.max(1, Math.ceil(r.w * tier)), h: Math.max(1, Math.ceil(r.h * tier)) });
  const tierOf = (r: AtlasRequest) => !visible.has(r.id) || (evicted.has(r.id) && !entries.has(r.id))
    ? 0.25 : [0.25, 0.5, 1, 2].find((t) => scale <= t * 1.25) ?? 2;
  const matches = (r: AtlasRequest, tier: number, e?: Entry) => e && e.key === r.key && e.w === r.w && e.h === r.h && e.tier === tier;

  function release(slot: Slot) {
    const p = slot.page;
    p.used--;
    if (!p.used) {
      deps.uploader.deletePage(p.id);
      pages.delete(p.id);
      return;
    }
    p.free.push({ x: slot.x, y: slot.y, w: slot.w, h: slot.h });
    // 이웃 빈칸을 합쳐 반복 교체가 쓸 수 없는 조각을 쌓지 않게 한다.
    for (let a = 0; a < p.free.length; a++) {
      for (let b = a + 1; b < p.free.length; b++) {
        const x = p.free[a], y = p.free[b];
        if (x.y === y.y && x.h === y.h && (x.x + x.w === y.x || y.x + y.w === x.x)) {
          p.free[a] = { x: Math.min(x.x, y.x), y: x.y, w: x.w + y.w, h: x.h };
        } else if (x.x === y.x && x.w === y.w && (x.y + x.h === y.y || y.y + y.h === x.y)) {
          p.free[a] = { x: x.x, y: Math.min(x.y, y.y), w: x.w, h: x.h + y.h };
        } else continue;
        p.free.splice(b, 1);
        a = -1;
        break;
      }
    }
  }

  function take(p: Page, w: number, h: number): Slot | null {
    const i = p.free.findIndex((b) => b.w >= w && b.h >= h);
    if (i < 0) return null;
    const b = p.free.splice(i, 1)[0];
    if (b.w > w) p.free.push({ x: b.x + w, y: b.y, w: b.w - w, h });
    if (b.h > h) p.free.push({ x: b.x, y: b.y + h, w: b.w, h: b.h - h });
    p.used++;
    return { page: p, x: b.x, y: b.y, w, h };
  }

  function allocate(r: AtlasRequest, tier: number): Slot {
    const { w, h } = pixels(r, tier);
    if (w > budget.uploadPx) throw new RangeError("Atlas row exceeds upload budget");
    const width = 2 ** Math.ceil(Math.log2(Math.max(budget.pageSize, w)));
    const height = 2 ** Math.ceil(Math.log2(Math.max(budget.pageSize, h)));
    const tryAllocate = () => {
      for (const p of pages.values()) {
        const slot = take(p, w, h);
        if (slot) return slot;
      }
      if (textureBytes() + width * height * 4 > budget.textureBytes) return null;
      const p: Page = { id: pageId++, width, height, free: [{ x: 0, y: 0, w: width, h: height }], used: 0 };
      deps.uploader.ensurePage(p.id, width, height);
      pages.set(p.id, p);
      return take(p, w, h);
    };
    let slot = tryAllocate();
    const victims = [...entries].filter(([id]) => !visible.has(id))
      .sort((a, b) => b[1].tier - a[1].tier || b[1].slot.w * b[1].slot.h - a[1].slot.w * a[1].slot.h);
    for (const [id, e] of victims) {
      if (slot) break;
      entries.delete(id);
      evicted.add(id);
      release(e.slot);
      slot = tryAllocate();
    }
    if (!slot) throw new RangeError("Atlas texture budget exhausted");
    return slot;
  }

  function closeImages(j: Job) {
    for (const img of j.images.values()) {
      if (img) { bitmapBytes -= img.width * img.height * 4; img.close(); }
    }
    j.images.clear();
  }

  function cancelJob(j: Job | null = job) {
    if (!j) return;
    j.cancelled = true;
    closeImages(j);
    if (j.slot) release(j.slot);
    prepared.delete(j.req.id);
    if (j === job) { job = null; failure = null; }
  }

  function stripHeight(j: Job) {
    const { w, h } = pixels(j.req, j.tier);
    // 절반은 굽기 띠에 남겨 여러 원본을 가진 현재 카드도 끝까지 준비할 수 있게 한다.
    const rows = Math.floor(Math.min(budget.uploadPx, Math.floor(budget.cpuBytes / 8)) / w);
    if (rows < 1) throw new RangeError("Atlas row exceeds CPU or upload budget");
    return Math.min(h - j.row, rows);
  }

  function trimPrefetch(bytes: number, keep: Job) {
    for (const other of [...prepared.values()].reverse()) {
      if (bitmapBytes + decodeReservedBytes + bytes <= budget.cpuBytes / 2) break;
      if (other === keep) continue;
      prefetchBlocked.add(other.req.id);
      cancelJob(other);
    }
  }

  function decodeImages(j: Job) {
    const { w } = pixels(j.req, j.tier);
    while (!j.cancelled && !failure && j.next < j.sources.length && decodeCount < budget.decodes) {
      const side = Math.min(w, Math.floor(Math.sqrt(budget.cpuBytes / 8 / j.sources.length)));
      if (side < 1) throw new RangeError("Atlas image count exceeds CPU budget");
      const reserve = side * side * 4;
      if (j === job) trimPrefetch(reserve, j);
      if (bitmapBytes + decodeReservedBytes + reserve > budget.cpuBytes / 2) break;
      const src = j.sources[j.next++];
      decodeCount++;
      decodeReservedBytes += reserve;
      j.loading++;
      const accept = (img: ImageBitmap | null) => {
        decodeCount--;
        decodeReservedBytes -= reserve;
        j.loading--;
        const bytes = img ? img.width * img.height * 4 : 0;
        recordCpuPeak(bytes);
        if (disposed || j.cancelled || j.generation !== generation) { img?.close(); return; }
        if (img && (img.width > side || img.height > side)) {
          img?.close();
          if (j === job) failure = new RangeError("Atlas decoder exceeded requested dimensions");
          else { prefetchBlocked.add(j.req.id); cancelJob(j); }
        } else {
          bitmapBytes += bytes;
          j.images.set(src, img);
        }
      };
      // 동기 예외도 실패 이미지로 처리해 다른 그림의 준비를 막지 않는다.
      try { Promise.resolve(deps.decode(src, side, side)).then(accept, () => accept(null)); }
      catch { accept(null); }
    }
  }

  function prepare(waiting: AtlasRequest[]) {
    const first = waiting[0];
    const head = waiting.slice(0, 9);
    const ids = new Set(head.map((r) => r.id));
    for (const j of prepared.values()) if (!ids.has(j.req.id)) cancelJob(j);
    for (const r of head) {
      if (!prepared.has(r.id) && (r === first || !prefetchBlocked.has(r.id))) {
        prepared.set(r.id, {
          req: { ...r }, tier: tierOf(r), slot: null, row: 0, cancelled: false, generation,
          images: new Map(), sources: [...new Set(r.sources)], next: 0, loading: 0,
        });
      }
    }
    job = first ? prepared.get(first.id) ?? null : null;
    if (job) decodeImages(job);
    for (const r of head) {
      const j = prepared.get(r.id);
      if (j && j !== job) decodeImages(j);
    }
  }

  function reset(nextGeneration: number) {
    for (const j of prepared.values()) cancelJob(j);
    for (const p of pages.values()) deps.uploader.deletePage(p.id);
    pages.clear();
    entries.clear();
    evicted.clear();
    prefetchBlocked.clear();
    requests = [];
    failure = null;
    generation = nextGeneration;
    settled = false;
  }

  const atlas: CardAtlas = {
    sync(reqs, visibleIds, screenScale, nextGeneration) {
      if (disposed) return;
      if (generation !== nextGeneration) reset(nextGeneration);
      if (!Number.isFinite(screenScale) || screenScale <= 0) throw new RangeError("Invalid atlas scale");
      const ids = new Set<string>();
      for (const r of reqs) {
        if (ids.has(r.id) || !Number.isFinite(r.w) || !Number.isFinite(r.h) || r.w <= 0 || r.h <= 0) throw new RangeError("Invalid atlas request");
        ids.add(r.id);
      }
      requests = reqs.slice();
      visible = new Set(visibleIds);
      scale = screenScale;
      settled = false;
      const byId = new Map(requests.map((r) => [r.id, r]));
      for (const j of prepared.values()) {
        const r = byId.get(j.req.id);
        if (!r || r.key !== j.req.key || r.w !== j.req.w || r.h !== j.req.h || tierOf(r) !== j.tier) cancelJob(j);
      }
      prefetchBlocked.clear();
      for (const [id, e] of entries) if (!ids.has(id)) { entries.delete(id); release(e.slot); evicted.delete(id); }
      for (const id of evicted) if (!ids.has(id)) evicted.delete(id);
      const first = requests.find((r) => visible.has(r.id) && !matches(r, tierOf(r), entries.get(r.id)))
        ?? requests.find((r) => !evicted.has(r.id) && !matches(r, tierOf(r), entries.get(r.id)));
      job = first ? prepared.get(first.id) ?? null : null;
    },
    tick() {
      if (disposed) return { baked: 0, uploadedPx: 0, pending: 0 };
      if (failure) { const error = failure; cancelJob(); failure = null; throw error; }
      if (settled && !job) return { baked: 0, uploadedPx: 0, pending: 0 };
      const start = deps.now();
      let baked = 0, uploadedPx = 0;
      const waiting = requests.filter((r) => !matches(r, tierOf(r), entries.get(r.id)) && (visible.has(r.id) || !evicted.has(r.id)))
        .sort((a, b) => Number(visible.has(b.id)) - Number(visible.has(a.id)));
      const bakedIds = new Set<string>();
      prepare(waiting);
      while (deps.now() - start < budget.bakeMs) {
        const ready = waiting.find((r) => {
          const j = prepared.get(r.id);
          return j && !j.cancelled && !bakedIds.has(r.id) && !j.loading && j.next === j.sources.length;
        });
        const j = ready ? prepared.get(ready.id) : undefined;
        if (!j || failure) break;
        if (!visible.has(j.req.id) && evicted.has(j.req.id)) {
          cancelJob(j);
          waiting.splice(waiting.findIndex((r) => r.id === j.req.id), 1);
          prepare(waiting);
          continue;
        }
        const sizePx = pixels(j.req, j.tier);
        const h = stripHeight(j);
        const px = sizePx.w * h;
        if (uploadedPx + px > budget.uploadPx) break;
        trimPrefetch(0, j);
        if (bitmapBytes + decodeReservedBytes + px * 4 > budget.cpuBytes) { cancelJob(j); throw new RangeError("Atlas baking buffer exceeds CPU budget"); }
        j.slot ??= allocate(j.req, j.tier);
        let canvas: HTMLCanvasElement | OffscreenCanvas | null = null;
        try {
          canvas = deps.makeCanvas(j.slot.w, h);
          canvasBytes = px * 4;
          recordCpuPeak();
          const g = canvas.getContext("2d") as CanvasRenderingContext2D | null;
          if (!g) throw new Error("Atlas Canvas2D unavailable");
          g.save();
          g.setTransform(j.tier, 0, 0, j.tier, 0, -j.row);
          g.beginPath();
          g.rect(0, j.row / j.tier, j.req.w, h / j.tier);
          g.clip();
          j.req.draw(g, (src) => j.images.get(src) ?? null);
          g.restore();
          deps.uploader.upload(j.slot.page.id, j.slot.x, j.slot.y + j.row, canvas, j.slot.w, h);
        } catch (error) {
          cancelJob(j);
          throw error;
        } finally {
          if (canvas) { canvas.width = 0; canvas.height = 0; } // 굽고 올린 뒤 놓는다(CPU 굽기 버퍼 예산)
          canvasBytes = 0;
          closeImages(j);
        }
        baked++;
        bakedIds.add(j.req.id);
        uploadedPx += px;
        j.row += h;
        if (j.row < j.slot.h) {
          // 띠 사이에는 비트맵을 놓고 다음 프레임에 필요한 크기로 다시 받는다.
          j.next = 0;
          prepare(waiting);
          continue;
        }
        const old = entries.get(j.req.id);
        const s = j.slot, { width, height } = s.page;
        entries.set(j.req.id, {
          key: j.req.key, w: j.req.w, h: j.req.h, tier: j.tier, slot: s,
          region: { page: s.page.id, tier: j.tier, u0: (s.x + 0.5) / width, v0: (s.y + 0.5) / height, u1: (s.x + s.w - 0.5) / width, v1: (s.y + s.h - 0.5) / height },
        });
        if (old) release(old.slot);
        evicted.delete(j.req.id);
        const waitingIndex = waiting.findIndex((r) => r.id === j.req.id);
        if (waitingIndex >= 0 && matches(j.req, tierOf(j.req), entries.get(j.req.id))) waiting.splice(waitingIndex, 1);
        prepared.delete(j.req.id);
        if (job === j) job = null;
        prefetchBlocked.delete(j.req.id);
        prepare(waiting);
      }
      const pending = waiting.length;
      if (!pending) settled = true;
      return { baked, uploadedPx, pending };
    },
    lookup: (id) => entries.get(id)?.region ?? null,
    textureBytes,
    cpuBytes: () => bitmapBytes + canvasBytes,
    cpuPeak: () => cpuPeakBytes,
    reset,
    dispose() { if (!disposed) { reset(generation + 1); disposed = true; } },
  };
  return atlas;
}
