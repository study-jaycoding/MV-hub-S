// @vitest-environment jsdom
// 목록에서 직접 묶을 때의 자료(lib/useLocalFolderCards) — 지금 조회의 목록을 따로 끝까지 받는다.
//  고정하는 것: ① 끝까지 받은 결과만 내놓는다 ② 같은 자리에서 조회만 바뀌면 앞 결과를 쥔다(fresh 거짓) ③ 자리가 바뀌면 버린다 ·
//  다시 받는 때(조회가 바뀜 · 같은 조회에서 내용 신호(첫 쪽 서명·서버 카드)가 바뀜 — 그 조회에서 처음 본 값은 기준일 뿐) · 한 번에 하나 ·
//  공간 필터 · 상한 · 실패.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GenQuery, Generation } from "../src/types";
import { APP_EVENTS, dispatchAppEvent } from "../src/lib/appEvents";
import { generationChangeScope, getGenerationReadModel, type GenerationChange } from "../src/features/library/api";
import { groupGenerations } from "../src/lib/folderCardsLocal";
import { onLibraryChanged } from "../src/lib/libraryBroadcast";
import { configureOperationContext } from "../src/app/operationContext";

const listGenerations = vi.fn();
vi.mock("../src/api", () => ({ api: { listGenerations: (...args: unknown[]) => listGenerations(...args) }, GEN_PAGE: 200 }));
const { useLocalFolderCards } = await import("../src/lib/useLocalFolderCards");
const { LIBRARY_LIST_TIMEOUT_MS } = await import("../src/lib/libraryRequestTimeout");
type Scope = NonNullable<Parameters<typeof useLocalFolderCards>[0]["place"]>;

const gen = (id: string, extra: Partial<Generation> = {}) =>
  ({ id, project_id: "p1", folder_path: "e035/C0010", sort_ts: 1, workspace_scope: "team", workspace_id: "w1", ...extra }) as unknown as Generation;
const place: Scope = { projectId: "p1", parent: "e035" };
const query = (extra: Partial<GenQuery> = {}): GenQuery => ({ tab: "team", project_id: "p1", folder_path: "e035", colors: [], tags: [], auto_tags: [], ...extra });

let root: Root;
let host: HTMLDivElement;
let latest: ReturnType<typeof useLocalFolderCards>;
function Harness(props: Parameters<typeof useLocalFolderCards>[0]) {
  latest = useLocalFolderCards(props);
  return null;
}
const draw = (props: Partial<Parameters<typeof useLocalFolderCards>[0]>) =>
  act(() => root.render(<Harness place={place} query={query()} authKey="auth" listSig={null} base={null} {...props} />));
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
const ids = () => latest.gens?.map((g) => g.id) ?? null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  listGenerations.mockReset();
  configureOperationContext({ key: "auth", serverOrigin: location.origin, authority: "local", ready: true });
  getGenerationReadModel("auth", "local");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

let tagSequence = 0;
const tagChange = (overrides: Partial<GenerationChange> = {}): GenerationChange => ({
  version: 1, id: `local-folder-tags:${++tagSequence}`, scope: generationChangeScope(), resourceIds: ["tail"],
  changedFields: ["tags"], affectsMembership: false, source: "local", ...overrides,
});
function settleTags(change: GenerationChange, raw = false) {
  const detail = { ids: change.resourceIds, fields: change.changedFields, change };
  act(() => {
    if (raw) window.dispatchEvent(new CustomEvent(APP_EVENTS.generationTagsSettled, { detail }));
    else dispatchAppEvent(APP_EVENTS.generationTagsSettled, detail);
  });
}
const groupedCount = () => {
  const grouped = groupGenerations(latest.gens ?? [], place.projectId, place.parent, null);
  return grouped.folders.reduce((sum, folder) => sum + folder.count, grouped.own_count);
};

it.each([
  [{ tag: "wanted" }, "tags"],
  [{ tags: ["wanted"] }, "tags"],
  [{ search: "wanted" }, "tags"],
  [{ auto_tags: ["wanted"] }, "auto_tags"],
] as const)("T06 settled %j rechecks the 201st row with unchanged first page and folder cards", async (filter, field) => {
  const firstPage = Array.from({ length: 200 }, (_, index) => gen(`first-${index}`, { sort_ts: 1000 - index }));
  const before = [...firstPage, gen("tail")];
  const cards = groupGenerations(before, place.projectId, place.parent, null);
  cards.folders[0].rep = true; // 태그를 바꾸는 tail은 대표도 첫 쪽도 아니다.
  const signature = firstPage.map((g) => g.id).join(",");
  const props = { query: query({ ...filter }), listSig: signature, base: cards };
  listGenerations.mockResolvedValue(before);
  draw(props);
  await settle();
  expect([groupedCount(), latest.fresh]).toEqual([201, true]);

  let release!: (rows: Generation[]) => void;
  listGenerations.mockImplementationOnce(() => new Promise<Generation[]>((resolve) => { release = resolve; }));
  settleTags(tagChange({ changedFields: [field] }));
  draw(props); // App의 첫 쪽과 비필터 서버 집계 응답은 그대로다.
  await settle();
  expect([listGenerations.mock.calls.length, groupedCount(), latest.fresh, latest.loading]).toEqual([2, 201, false, true]);
  await act(async () => { release(firstPage); });
  await settle();
  expect([groupedCount(), latest.fresh, latest.loading, latest.failed]).toEqual([200, true, false, false]);
  expect(cards.folders[0].count).toBe(201); // 비필터 서버 집계/대표 객체는 바꾸지 않는다.
  expect(cards.folders[0].rep).toBe(true);
});

it("T06 rejects foreign scopes, unrelated fields, empty and duplicate settled changes", async () => {
  listGenerations.mockResolvedValue([gen("one")]);
  const props = { query: query({ tags: ["wanted"] }), listSig: "one", base: {} };
  draw(props);
  await settle();
  const valid = tagChange();
  for (const change of [
    tagChange({ scope: { ...valid.scope, accountNamespace: "other" } }),
    tagChange({ scope: { ...valid.scope, serverOrigin: "https://other.invalid" } }),
    tagChange({ scope: { ...valid.scope, connectionKey: "old-connection" } }),
    tagChange({ resourceIds: [] }), tagChange({ changedFields: [] }),
    tagChange({ changedFields: ["auto_tags"] }), tagChange({ changedFields: ["color"] }),
    tagChange({ affectsMembership: true }),
  ]) settleTags(change, true);
  act(() => window.dispatchEvent(new CustomEvent(APP_EVENTS.generationTagsSettled, { detail: { ids: ["tail"], fields: ["tags"] } })));
  await settle();
  expect(listGenerations).toHaveBeenCalledTimes(1);
  // 읽기 캐시 선택은 App이 확정한 이벤트 연결 키를 바꾸지 않는다(R4-6).
  getGenerationReadModel("view-only-cache-key", "team");
  expect(generationChangeScope().connectionKey).toBe("auth");
  settleTags(valid, true);
  await settle();
  expect(listGenerations).toHaveBeenCalledTimes(2);
  draw({ ...props, query: { ...props.query } });
  settleTags(valid, true);
  await settle();
  expect(listGenerations).toHaveBeenCalledTimes(2);
});

it("T06 tag-free grouping and auto-tag filters ignore unrelated manual tags", async () => {
  listGenerations.mockResolvedValue([gen("one")]);
  for (const filter of [{}, { media_type: "video" }, { auto_tags: ["wanted"] }] as Partial<GenQuery>[]) {
    draw({ query: query(filter) });
    await settle();
    const calls = listGenerations.mock.calls.length;
    settleTags(tagChange());
    await settle();
    expect(listGenerations).toHaveBeenCalledTimes(calls);
  }
});

it("T06 peer bridge revalidates filtered grouping once without waking broad consumers", async () => {
  let channel!: { onmessage: ((event: { data: unknown }) => void) | null };
  vi.stubGlobal("BroadcastChannel", class {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    constructor() { channel = this; }
    close() {}
  });
  const broad = vi.fn(), peer = vi.fn();
  const off = onLibraryChanged(broad, peer); // App 목록 훅이 갖는 실제 BC → DOM 연결.
  try {
    listGenerations.mockResolvedValue([gen("old"), gen("tail")]);
    draw({ query: query({ tag: "wanted" }) });
    await settle();
    listGenerations.mockResolvedValue([gen("old")]);
    const message = { tab: "peer", event: APP_EVENTS.generationTagsSettled, change: tagChange() };
    act(() => { channel.onmessage?.({ data: message }); channel.onmessage?.({ data: message }); });
    await settle();
    expect([groupedCount(), listGenerations.mock.calls.length, latest.fresh]).toEqual([1, 2, true]);
    expect(peer).toHaveBeenCalledTimes(1);
    expect(broad).not.toHaveBeenCalled();
  } finally {
    off();
    vi.unstubAllGlobals();
  }
});

it("T06 settled requery failure stays stale and a later change retries; old-account responses are discarded", async () => {
  const filtered = query({ tags: ["wanted"] });
  listGenerations.mockResolvedValue([gen("old")]);
  draw({ query: filtered });
  await settle();
  listGenerations.mockRejectedValueOnce(new Error("502"));
  settleTags(tagChange());
  await settle();
  expect([ids(), latest.fresh, latest.failed, latest.loading]).toEqual([["old"], false, true, false]);

  let release!: (rows: Generation[]) => void;
  listGenerations.mockImplementationOnce(() => new Promise<Generation[]>((resolve) => { release = resolve; }));
  settleTags(tagChange());
  await settle();
  expect([latest.fresh, latest.failed, latest.loading]).toEqual([false, false, true]);
  const oldChange = tagChange();
  configureOperationContext({ key: "new-auth", serverOrigin: location.origin, authority: "local", ready: true });
  getGenerationReadModel("new-auth", "local");
  draw({ query: filtered, authKey: "new-auth" });
  expect(latest.gens).toBeNull();
  settleTags(oldChange, true);
  await settle();
  expect(listGenerations).toHaveBeenCalledTimes(3);
  listGenerations.mockResolvedValue([gen("new-account")]);
  await act(async () => { release([gen("stale-account")]); });
  await settle();
  expect([ids(), latest.fresh]).toEqual([["new-account"], true]);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

it("끝까지 받은 결과만 내놓는다 — 쪽을 넘겨 받고, 공간 필터는 받은 뒤 한 번 더 거른다. 자리가 없으면 받지 않는다", async () => {
  const first = Array.from({ length: 500 }, (_, index) => gen("a" + index, { sort_ts: 1000 - index }));
  let release!: (page: Generation[]) => void;
  listGenerations.mockImplementation((_q: GenQuery, cursor: unknown) =>
    (cursor ? new Promise<Generation[]>((resolve) => { release = resolve; }) : Promise.resolve(first)));
  draw({ place: null });
  await settle();
  expect([listGenerations.mock.calls.length, latest.gens, latest.loading]).toEqual([0, null, false]);

  const filtered = query({ workspace_ids: ["w1"] });
  draw({ query: filtered });
  await settle();
  // 첫 쪽(500건 = 한도)만 왔다 — 아직 내놓지 않는다
  expect([listGenerations.mock.calls.length, listGenerations.mock.calls[1][1], listGenerations.mock.calls[1][2], latest.gens, latest.loading])
    .toEqual([2, { ts: 501, id: "a499" }, 500, null, true]);
  await act(async () => { release([gen("tail"), gen("elsewhere", { workspace_id: "w2" })]); });
  await settle();
  expect([latest.gens!.length, ids()!.slice(-1), latest.fresh, latest.truncated, latest.loading]).toEqual([501, ["tail"], true, false, false]);
  // 묶기는 프롬프트를 읽지 않는다 — 쪽마다 빈 글로 받는다(42회차)
  expect(listGenerations.mock.calls.map((call) => [call[3].leanPrompt, call[3].signal instanceof AbortSignal])).toEqual([[true, true], [true, true]]);
});

it("같은 자리에서 조회만 바뀌면 앞 결과를 쥔 채 새로 받고, 자리가 바뀌면 버린다", async () => {
  const waiting: Array<(page: Generation[]) => void> = [];
  listGenerations.mockImplementation(() => new Promise<Generation[]>((resolve) => { waiting.push(resolve); }));
  draw({});
  await settle(); // 요청은 한 박자 뒤에 나간다(한 번에 하나 — 앞 요청의 끝을 기다리는 줄)
  await act(async () => { waiting[0]([gen("all-1"), gen("all-2")]); });
  await settle();
  expect([ids(), latest.fresh]).toEqual([["all-1", "all-2"], true]);

  // 종류를 영상으로 — 새 답이 올 때까지 앞 결과를 그대로(fresh 거짓 · loading 참)
  draw({ query: query({ media_type: "video" }) });
  await settle();
  expect([ids(), latest.fresh, latest.loading, waiting.length]).toEqual([["all-1", "all-2"], false, true, 2]);
  await act(async () => { waiting[1]([gen("video-1")]); });
  await settle();
  expect([ids(), latest.fresh, latest.loading]).toEqual([["video-1"], true, false]);

  // 다른 자리 — 곧바로 버린다(남의 자리의 것을 내놓지 않는다). 계정·서버가 바뀌어도 같다
  draw({ query: query({ media_type: "video", folder_path: "e036" }), place: { projectId: "p1", parent: "e036" } });
  expect([latest.gens, latest.fresh, latest.loading]).toEqual([null, false, true]);
  await settle();
  await act(async () => { waiting[2]([gen("e036-1", { folder_path: "e036/C0010" })]); });
  await settle();
  expect(ids()).toEqual(["e036-1"]);
  draw({ query: query({ media_type: "video", folder_path: "e036" }), place: { projectId: "p1", parent: "e036" }, authKey: "other-account" });
  expect(latest.gens).toBeNull();
});

it("같은 조회에서 내용이 바뀌었다는 신호(첫 쪽 서명 · 서버 카드)에 다시 받는다 — 그 조회에서 처음 본 값은 기준일 뿐, 목록이 남의 것(null)이면 신호가 아니다", async () => {
  listGenerations.mockResolvedValue([gen("one")]);
  const cards = { parent: "e035" };
  draw({});
  await settle();
  expect(listGenerations).toHaveBeenCalledTimes(1);
  draw({ listSig: "one", base: cards }); // 이 조회의 첫 값 — 기준
  await settle();
  draw({ listSig: "one", base: cards }); // 주기 조회가 같은 내용을 받았다 — 다시 받지 않는다
  await settle();
  expect(listGenerations).toHaveBeenCalledTimes(1);

  listGenerations.mockResolvedValue([gen("new"), gen("one")]);
  draw({ listSig: "new,one", base: cards }); // 첫 쪽의 내용이 바뀌었다 — 다시 받는다. 받는 동안 앞 결과는 그대로(같은 조회라 fresh)
  expect([ids(), latest.fresh]).toEqual([["one"], true]);
  await settle();
  expect([listGenerations.mock.calls.length, ids()]).toEqual([2, ["new", "one"]]);
  draw({ listSig: "new,one", base: { parent: "e035" } }); // 서버 카드가 새로 왔다(첫 쪽 밖의 것이 바뀌었을 수 있다) — 다시 받는다
  await settle();
  expect(listGenerations).toHaveBeenCalledTimes(3);

  draw({ listSig: null, base: null }); // 폴더 창이 떴다 — 목록은 창의 것
  await settle();
  // 조회가 바뀌면 그 조회로 한 번 받고, 뒤따라 온 새 조회의 첫 값들은 기준으로만 삼는다(두 번 받지 않는다)
  const video = query({ media_type: "video" });
  draw({ query: video });
  await settle();
  draw({ query: video, listSig: "v", base: { parent: "e035" } });
  await settle();
  expect(listGenerations).toHaveBeenCalledTimes(4);
});

// Codex 코드 리뷰: 조건마다 곧바로 500건 요청을 보내면 느린 서버에서 조건을 연달아 바꿀 때 큰 요청이 쌓인다 — 한 번에 하나, 마지막 조회만.
it("한 번에 하나만 받는다 — 받는 중에 조회가 연달아 바뀌면 끝난 뒤 마지막 조회만 보낸다", async () => {
  const waiting: Array<(page: Generation[]) => void> = [];
  listGenerations.mockImplementation(() => new Promise<Generation[]>((resolve) => { waiting.push(resolve); }));
  draw({});
  await settle();
  draw({ query: query({ media_type: "video" }) });
  await settle();
  draw({ query: query({ media_type: "image" }) });
  await settle();
  expect(listGenerations).toHaveBeenCalledTimes(1); // 첫 조회가 아직 받는 중 — 뒤의 둘은 기다린다
  await act(async () => { waiting[0]([gen("all")]); });
  await settle();
  // 버려진 첫 응답은 쓰지 않고, 건너뛴 조회(영상)는 보내지도 않는다 — 마지막(이미지)만
  expect([listGenerations.mock.calls.length, listGenerations.mock.calls[1][0].media_type, latest.gens]).toEqual([2, "image", null]);
  await act(async () => { waiting[1]([gen("image-1")]); });
  await settle();
  expect([ids(), latest.fresh]).toEqual([["image-1"], true]);
});

// 81회차 F-B-03: 앞 요청이 답 없이 멈추면 한 줄 대기열이 끝없이 막혀 뒤 조회가 출발하지 못했다 — 쪽마다 30초 뒤 실제로 끊는다.
//  제한은 쪽마다다 — 첫 쪽이 20초 걸려도 다음 쪽은 제 30초를 받는다(전체 30초면 20+10초에 끊긴다, Codex 리뷰 P3).
it.each([["첫 쪽", 0, 0], ["다음 쪽", 1, 20_000]])("stalled page releases the lane and starts the latest query — %s이 멈추면 30초 뒤 실제로 끊고, 건너뛴 조회는 보내지 않고 마지막만 보낸다", async (_name, stallAt, firstDelay) => {
  vi.useFakeTimers();
  try {
    let inFlight = 0;
    let maxInFlight = 0;
    const signals: Array<AbortSignal | undefined> = [];
    const full = Array.from({ length: 500 }, (_, index) => gen("a" + index, { sort_ts: 1000 - index }));
    listGenerations.mockImplementation((_q: GenQuery, _cursor: unknown, _limit: number, opts: { signal?: AbortSignal } = {}) => {
      const at = signals.length;
      signals.push(opts.signal);
      if (at < stallAt) return new Promise<Generation[]>((resolve) => { setTimeout(() => resolve(full), firstDelay); });
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise<Generation[]>((_resolve, reject) => {
        opts.signal?.addEventListener("abort", () => { inFlight -= 1; reject(new DOMException("aborted", "AbortError")); });
      });
    });
    draw({}); // A — 멈춘다
    await settle();
    await act(async () => { await vi.advanceTimersByTimeAsync(firstDelay); }); // 앞 쪽이 늦게(20초) 끝나고 다음 쪽이 나간다(그 쪽의 30초는 여기서부터)
    draw({ query: query({ media_type: "video" }) }); // B — 건너뛴다
    await settle();
    draw({ query: query({ media_type: "image" }) }); // C — 마지막
    await settle();
    expect(listGenerations).toHaveBeenCalledTimes(stallAt + 1);
    await act(async () => { await vi.advanceTimersByTimeAsync(LIBRARY_LIST_TIMEOUT_MS - 1); });
    expect([listGenerations.mock.calls.length, signals[stallAt]?.aborted]).toEqual([stallAt + 1, false]);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    await settle();
    const next = listGenerations.mock.calls[stallAt + 1];
    expect([signals[stallAt]?.aborted, listGenerations.mock.calls.length, next?.[0].media_type, next?.[1], maxInFlight])
      .toEqual([true, stallAt + 2, "image", null, 1]);
  } finally {
    vi.useRealTimers();
  }
});

it("ready 가 거짓이면 받기를 미룬다 — 참이 되면 받고, 그 뒤 들락날락해도 쥔 결과를 내놓은 채 다시 받지 않는다", async () => {
  listGenerations.mockResolvedValue([gen("one")]);
  draw({ ready: false });
  await settle();
  expect([listGenerations.mock.calls.length, latest.gens, latest.loading]).toEqual([0, null, true]);
  draw({ ready: true });
  await settle();
  expect([listGenerations.mock.calls.length, ids(), latest.fresh]).toEqual([1, ["one"], true]);
  draw({ ready: false }); // 폴더 창이 떴다(본 목록이 창의 것) — 쥔 것은 그대로
  await settle();
  expect([ids(), latest.fresh]).toEqual([["one"], true]);
  draw({ ready: true });
  await settle();
  expect(listGenerations).toHaveBeenCalledTimes(1);
  // 다른 조회로 갔다 돌아오면 다시 받는다 — 건너뛰기는 같은 조회에 머문 채 ready 만 바뀔 때의 것이다(Codex 코드 리뷰: A → B → A)
  listGenerations.mockRejectedValueOnce(new Error("502"));
  draw({ query: query({ media_type: "video" }) });
  await settle();
  listGenerations.mockResolvedValue([gen("two"), gen("one")]);
  draw({});
  await settle();
  expect([listGenerations.mock.calls.length, ids(), latest.fresh]).toEqual([3, ["two", "one"], true]);
});

it("상한(2000건)에서 잘리면 truncated, 실패하면 앞 결과를 쥔 채 loading 만 내린다", async () => {
  const page = (start: number) => Array.from({ length: 500 }, (_, index) => gen(`g${start + index}`, { sort_ts: 5000 - start - index }));
  let calls = 0;
  listGenerations.mockImplementation(async () => page(500 * calls++));
  draw({});
  await settle();
  await settle();
  await settle();
  expect([calls, latest.gens!.length, latest.truncated, latest.fresh]).toEqual([4, 2000, true, true]);

  listGenerations.mockRejectedValue(new Error("502"));
  draw({ query: query({ search: "cat" }) });
  await settle();
  expect([latest.gens!.length, latest.fresh, latest.loading, latest.failed]).toEqual([2000, false, false, true]);
  // 다른 조회로 바꿔 받으면 실패 표시는 내려간다
  listGenerations.mockResolvedValue([gen("ok")]);
  draw({ query: query({ search: "dog" }) });
  await settle();
  expect([ids(), latest.fresh, latest.failed]).toEqual([["ok"], true, false]);
});

// ── 83회차: 기다릴 수 있는 받기(request) — 걸러 보는 컷 화면이 이 목록의 주인일 때 App 이 진입 ensure·주기 check·실제 변경 invalidate 로 부른다 ──
type Outcome = Awaited<ReturnType<typeof latest.request>>;
const flush = () => act(async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); });
const rows = (n: number, prefix: string, extra: Partial<Generation> = {}) =>
  Array.from({ length: n }, (_, index) => gen(prefix + index, { sort_ts: 100_000 - index, ...extra }));
// 서버 흉내 — 쪽 요청에 그 순간의 표를 커서로 잘라 준다. held 면 응답을 줄 세워 붙잡는다(release 로 하나씩)
function server(initial: Generation[]) {
  const state = { table: initial, held: false, waiting: [] as Array<() => void> };
  listGenerations.mockImplementation((_q: GenQuery, cursor: { id: string } | null, limit: number) => {
    const from = cursor ? state.table.findIndex((g) => g.id === cursor.id) + 1 : 0;
    const page = state.table.slice(from, from + limit); // 보낸 순간의 표
    if (!state.held) return Promise.resolve(page);
    return new Promise<Generation[]>((resolve) => { state.waiting.push(() => resolve(page)); });
  });
  return state;
}
const release = async (state: ReturnType<typeof server>) => {
  const next = state.waiting.shift()!;
  await act(async () => { next(); });
  await flush();
};
const ask = async (intent: Parameters<typeof latest.request>[0], refresh?: Parameters<typeof latest.request>[1]) => {
  let outcome!: Outcome;
  await act(async () => { outcome = await latest.request(intent, refresh); });
  await flush();
  return outcome;
};
const cursors = (from = 0) => listGenerations.mock.calls.slice(from).map((call) => (call[1] as { id: string } | null)?.id ?? null);

// Codex FE-04: 평상시 확인과 실제 변경 통보를 가른다 — 받는 중의 확인은 합류해 응답을 버리지 않고(4초 응답에 3초 주기), 통보 여럿은 끝난 뒤 한 번으로 남는다.
//  답이 없거나 직전이 실패면 확인도 처음부터 끝까지 받는다.
it("cut_poll_joins_and_invalidation_survives — 받는 중의 check·ensure 는 합류, invalidate 여럿은 끝난 뒤 한 번 · 실패 뒤 check 는 처음부터, 그대로면 첫 쪽 한 번", async () => {
  const srv = server(rows(3, "a"));
  srv.held = true;
  draw({});
  await flush();
  expect(listGenerations).toHaveBeenCalledTimes(1); // 진입(ensure)
  let polled: Outcome | null = null;
  act(() => { void latest.request("check").then((outcome) => { polled = outcome; }); }); // 주기 조회 — 받는 중이면 합류(새로 보내지 않는다)
  act(() => { void latest.request("ensure"); });
  srv.table = rows(4, "b"); // 그사이 실제로 바뀌었다 — 통보 둘
  const notices: Outcome[] = [];
  act(() => {
    void latest.request("invalidate").then((outcome) => notices.push(outcome));
    void latest.request("invalidate").then((outcome) => notices.push(outcome));
  });
  expect(listGenerations).toHaveBeenCalledTimes(1);
  await release(srv);
  // 앞 응답은 적용했다(버리지 않는다) · 통보 둘은 끝난 뒤 한 번 — 그 약속은 그 뒤 실행이 끝날 때 풀린다
  expect([ids(), polled?.status, notices.length, listGenerations.mock.calls.length]).toEqual([["a0", "a1", "a2"], "applied", 0, 2]);
  act(() => { void latest.request("check"); }); // 뒤 실행을 받는 중 — 합류
  expect(listGenerations).toHaveBeenCalledTimes(2);
  await release(srv);
  expect([ids(), notices.map((outcome) => outcome.status), listGenerations.mock.calls.length]).toEqual([["b0", "b1", "b2", "b3"], ["applied", "applied"], 2]);

  srv.held = false;
  srv.table = rows(501, "c"); // 두 쪽 — 첫 쪽 확인(한 번)과 처음부터 받기(두 번)를 가른다
  listGenerations.mockRejectedValueOnce(new Error("502"));
  expect([(await ask("invalidate")).status, ids()!.length, latest.failed]).toEqual(["failed", 4, true]); // 쥔 것은 그대로
  let before = listGenerations.mock.calls.length;
  expect((await ask("check")).status).toBe("applied");
  expect([cursors(before), ids()!.length, latest.failed]).toEqual([[null, "c499"], 501, false]); // 실패 뒤 확인 = 처음부터
  before = listGenerations.mock.calls.length;
  expect([(await ask("check")).status, cursors(before)]).toEqual(["applied", [null]]); // 그대로 — 첫 쪽 한 번
  expect([(await ask("ensure")).status, cursors(before)]).toEqual(["reused", [null]]); // 진입 — 쥔 답 그대로
});

// Codex FE-06: 같은 갱신의 첫 쪽과 서버 카드는 한 실행에서 함께 견준다 — 어느 쪽이 먼저 와도 끝까지 받기는 한 번이고, 그 카드가 화면(base)에 와도
//  감시가 그것을 새 바뀜으로 읽지 않는다. 대표 저장처럼 다른 길로 온 카드는 한 번 반영한다.
it.each([["서버 카드 먼저", true], ["첫 쪽 먼저", false]])("cut_refresh_base_order_does_not_refetch_twice — %s: 끝까지 받기는 한 번(첫 쪽은 다시 받지 않는다) · 다른 길의 카드는 한 번", async (_order, cardsFirst) => {
  const srv = server(rows(501, "a"));
  const before = { parent: "e035", v: 1 };
  draw({ base: before });
  await flush();
  expect(cursors()).toEqual([null, "a499"]);
  srv.table = [gen("new", { sort_ts: 200_000 }), ...rows(501, "a")]; // 맨 위에 새 것 — 첫 쪽이 바뀌었다
  const after = { parent: "e035", v: 2 }; // 서버 카드도 바뀌었다
  let giveCards!: () => void;
  const refresh = vi.fn(() => new Promise<{ status: string; cards: object | null }>((resolve) => { giveCards = () => resolve({ status: "applied", cards: after }); }));
  srv.held = true;
  let outcome: Outcome | null = null;
  act(() => { void latest.request("check", refresh).then((done) => { outcome = done; }); });
  await flush();
  expect([cursors(2), refresh.mock.calls.length]).toEqual([[null], 1]); // 첫 쪽과 서버 카드가 함께 출발
  if (cardsFirst) {
    await act(async () => { giveCards(); });
    draw({ base: after }); // 그 카드가 화면에 왔다(App 이 다시 그린다)
    await flush();
    await release(srv);
  } else {
    await release(srv);
    await act(async () => { giveCards(); });
    draw({ base: after });
    await flush();
  }
  while (srv.waiting.length) await release(srv);
  expect([outcome?.status, ids()![0], ids()!.length, cursors(2)]).toEqual(["applied", "new", 502, [null, "a498"]]); // 받은 첫 쪽에 이어 둘째 쪽만
  srv.held = false;
  draw({ base: after });
  await flush();
  expect(listGenerations).toHaveBeenCalledTimes(4); // 같은 갱신의 카드로 또 받지 않는다
  draw({ base: { parent: "e035", v: 3 } }); // 대표 저장 — 다른 길로 온 카드
  await flush();
  expect([cursors(4), refresh.mock.calls.length]).toEqual([[null, "a498"], 1]); // 한 번 반영(끝까지 다시)
});

// Codex FE-07: 확인의 기준은 서버가 준 첫 쪽 원본이다 — 공간 밖 행이 섞여도 원본 500건으로 다음 쪽을 잇고(걸러진 499건을 '마지막 쪽'으로 보지 않는다),
//  같은 내용의 확인을 바뀜으로 보지 않는다(표시용 앞 500건과 견주면 매번 달라 끝까지 받았을 것이다).
it("cut_first_page_uses_raw_rows_and_cursor — 공간 밖 행이 섞인 첫 쪽: 원본 마지막 행의 커서로 잇고, 같은 내용의 check 는 첫 쪽 한 번", async () => {
  const table = rows(501, "a").map((g, index) => (index === 3 ? { ...g, workspace_id: "w2" } : g));
  server(table);
  draw({ query: query({ workspace_ids: ["w1"] }) });
  await flush();
  expect([cursors(), ids()!.length, ids()!.includes("a3")]).toEqual([[null, "a499"], 500, false]);
  const before = listGenerations.mock.calls.length;
  expect([(await ask("check")).status, cursors(before)]).toEqual(["applied", [null]]);
  expect(ids()!.length).toBe(500);
});

// Codex FE-08: 다섯 칸 서명(id·최종·보류·폴더·상태)은 묶음·표지가 읽는 칸을 덮지 못한다 — 원본 lean 행 전체를 견준다.
it.each<[string, Partial<Generation>]>([
  ["assets", { assets: [{ type: "video", file_path: "/media/v.mp4" }] as Generation["assets"] }],
  ["shared_at", { shared_at: "2026-10-17 01:00:00" }], ["creator_uid", { creator_uid: "u-2" }], ["creator_name", { creator_name: "B" }],
  ["deleted", { deleted: true }], ["project_id", { project_id: "p2" }], ["model", { model: "other-model" }],
  ["created_at", { created_at: "2026-10-17 02:00:00" }], ["params(길이)", { params: { duration: 8 } }], ["sort_ts", { sort_ts: 150_000 }],
  ["is_final", { is_final: true }], ["status", { status: "failed" }],
])("cut_check_detects_every_consumed_field_change — 첫 쪽 행의 %s 만 바뀌어도 check 가 알아채고 바뀐 값을 내놓는다", async (_field, change) => {
  const srv = server(rows(2, "a"));
  draw({});
  await flush();
  const shown = latest.gens;
  expect((await ask("check")).status).toBe("applied");
  expect(latest.gens).toBe(shown); // 그대로면 결과를 갈아 끼우지 않는다
  srv.table = [{ ...srv.table[0], ...change } as Generation, srv.table[1]];
  expect((await ask("check")).status).toBe("applied");
  expect(latest.gens![0]).toMatchObject(change);
});

// FH 시험 3: 쪽 경계 — 정확히 500건이면 끝을 확인하는 빈 다음 쪽, 2,000건 상한 표시 규칙은 그대로. 그대로인 확인은 첫 쪽 한 번, 바뀌면 받은 첫 쪽에
//  이어 다음 커서로(첫 쪽을 다시 받지 않는다).
it.each([[0, [null], false], [411, [null], false], [500, [null, "a499"], false], [501, [null, "a499"], false],
  [2000, [null, "a499", "a999", "a1499"], true], [2001, [null, "a499", "a999", "a1499"], true]] as const)(
  "쪽 경계 %i건 — 처음 받기의 커서·상한, 그대로인 check 는 첫 쪽 한 번, 바뀐 check 는 이어 받기", async (count, firstCursors, truncated) => {
  const srv = server(rows(count, "a"));
  draw({});
  await flush();
  expect([cursors(), latest.gens!.length, latest.truncated]).toEqual([firstCursors, Math.min(count, 2000), truncated]);
  let before = listGenerations.mock.calls.length;
  expect([(await ask("check")).status, cursors(before)]).toEqual(["applied", [null]]);
  srv.table = [gen("top", { sort_ts: 500_000 }), ...srv.table];
  before = listGenerations.mock.calls.length;
  expect((await ask("check")).status).toBe("applied");
  const pages = Math.min(4, Math.floor((count + 1) / 500) + 1);
  // 바뀐 표의 i 번째 행 = i 가 0 이면 top, 아니면 a(i-1) — 쪽의 마지막 행(499·999·1499)이 다음 커서다
  expect([cursors(before), ids()![0], latest.gens!.length, latest.truncated])
    .toEqual([[null, ...Array.from({ length: pages - 1 }, (_, page) => `a${500 * (page + 1) - 2}`)], "top", Math.min(count + 1, 2000), count + 1 >= 2000]);
});

// fix8 P2: 목록은 적용됐고 같이 받은 서버 카드만 늦는 동안 조회가 B → A 로 돌아오면, 그 옛 A 실행은 늦은 카드가 와도 '적용'으로 끝나지 않는다(obsolete) —
//  돌아온 A 는 다른 회차다. 결과의 key 는 회차까지 실어 지금 조회 회차(contextKey)와 다르다.
it("late_cards_after_A_B_A — 카드만 늦는 동안 B → A 로 돌아오면 옛 A 실행은 obsolete, 결과 key 는 지금 회차와 다르다", async () => {
  server(rows(2, "a"));
  draw({});
  await flush();
  let give!: () => void;
  const refresh = vi.fn(() => new Promise<{ status: string; cards: object | null }>((resolve) => { give = () => resolve({ status: "applied", cards: { v: 2 } }); }));
  let outcome: Outcome | null = null;
  act(() => { void latest.request("invalidate", refresh).then((done) => { outcome = done; }); });
  await flush();
  expect([refresh.mock.calls.length, outcome]).toEqual([1, null]); // 목록은 적용 · 카드만 기다린다
  draw({ query: query({ search: "b" }) });
  await flush();
  draw({});
  await flush();
  await act(async () => { give(); });
  await flush();
  expect(outcome!.status).toBe("obsolete");
  expect(outcome!.key).not.toBe(latest.contextKey());
});
