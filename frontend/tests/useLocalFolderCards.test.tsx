// @vitest-environment jsdom
// 목록에서 직접 묶을 때의 자료(lib/useLocalFolderCards) — 지금 조회의 목록을 따로 끝까지 받는다.
//  고정하는 것: ① 끝까지 받은 결과만 내놓는다 ② 같은 자리에서 조회만 바뀌면 앞 결과를 쥔다(fresh 거짓) ③ 자리가 바뀌면 버린다 ·
//  다시 받는 때(조회가 바뀜 · 같은 조회에서 내용 신호(첫 쪽 서명·서버 카드)가 바뀜 — 그 조회에서 처음 본 값은 기준일 뿐) · 한 번에 하나 ·
//  공간 필터 · 상한 · 실패.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GenQuery, Generation } from "../src/types";

const listGenerations = vi.fn();
vi.mock("../src/api", () => ({ api: { listGenerations: (...args: unknown[]) => listGenerations(...args) }, GEN_PAGE: 200 }));
const { useLocalFolderCards } = await import("../src/lib/useLocalFolderCards");
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
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
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
