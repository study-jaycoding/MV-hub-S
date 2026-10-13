// @vitest-environment jsdom
// 공유 & 리뷰 탭의 폴더 묶음 보기 — 묶어 보일 수 있는 조회의 규칙, 폴더 카드 받기(문맥·순번·옛 서버), 컷 카드 격자.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FolderCard, FolderCards, GenQuery, Generation } from "../src/types";

const folderCardsApi = vi.hoisted(() => vi.fn());
vi.mock("../src/api", () => ({ api: { folderCards: folderCardsApi, thumbOrRaw: (path: string) => path } }));

import { FolderCardGrid } from "../src/components/FolderCardGrid";
import { folderCardsPlace, folderCardsScope, hasFindFilters, parentFolder, singleTeamWorkspace, type FolderCardsScope } from "../src/lib/folderCards";
import { HttpError } from "../src/lib/http";
import { forgetFolderCards, useFolderCards } from "../src/lib/useFolderCards";

const base: GenQuery = { tab: "team", project_id: "p1", folder_path: "e035", colors: [], tags: [], auto_tags: [] };
const cover = (id: string, type: "image" | "video" = "image") => ({
  id, project_id: "p1", project_name: "뻘뻘뻘", folder_path: "e035/C0010",
  assets: [{ type, file_path: `/media/${id}.png`, thumbnail_path: `/media/${id}.png` }],
}) as unknown as Generation;
const card = (name: string, count: number, rep = false, type: "image" | "video" = "image"): FolderCard => ({
  path: `e035/${name}`, name, count, rep, cover: cover(`cover-${name}`, type),
});
const cards = (...folders: FolderCard[]): FolderCards => ({ parent: "e035", own_count: 0, folders });

it("묶어 보일 수 있는 조회 — 공유 탭에서 프로젝트(또는 그 폴더)를 골랐고 무엇도 찾고 있지 않을 때만", () => {
  expect(folderCardsScope(base, false)).toEqual({ projectId: "p1", parent: "e035" });
  // 프로젝트만 골랐으면 맨 위 폴더(에피소드)마다
  expect(folderCardsScope({ ...base, folder_path: undefined }, false)).toEqual({ projectId: "p1", parent: "" });
  // 팀 공간 하나로 거르는 것까지는 서버가 같은 식으로 센다
  expect(folderCardsScope({ ...base, workspace_ids: ["ws-1"] }, false)).toEqual({ projectId: "p1", parent: "e035", workspaceId: "ws-1" });

  const flat: Partial<GenQuery>[] = [
    { tab: "my" }, { project_id: undefined }, { project_id: "none" },
    { search: "cat" }, { creator_uid: "u" }, { worker_id: "w" }, { share_dir: "mine" }, { local_only: true },
    { include_deleted: true }, { deleted_only: true }, { color: "r" }, { tag: "x" },
    { media_type: "video" }, { review_filter: "held" }, { shared_only: true }, { comment_only: true }, { final_only: true },
    { colors: ["r"] }, { tags: ["x"] }, { auto_tags: ["y"] },
    { workspace_ids: ["ws-1", "ws-2"] }, { workspace_scope: "personal" },
  ];
  for (const change of flat) expect([change, folderCardsScope({ ...base, ...change }, false)]).toEqual([change, null]);
  expect(folderCardsScope(base, true)).toBeNull(); // 회색 숨김은 이 PC 에만 있는 조건이라 서버가 못 센다
});

// 2026-10-13 저녁(Jay): 묶인 상태에서 태그·작성자·종류를 눌러도 묶음이 풀리지 않게 — '자리'와 '찾는 조건'을 가른다.
//  찾는 조건이 켜져 있어도 자리는 자리다(그때는 걸러진 목록을 화면이 직접 묶는다). 공간 조건·휴지통만 자리를 없앤다.
it("묶어 보일 자리 — 찾는 조건이 켜져 있어도 자리는 그대로, 자리가 아닌 것은 공유 탭 밖·프로젝트 없음·휴지통·서버가 못 거르는 공간 조건", () => {
  const finds: Partial<GenQuery>[] = [
    { search: "cat" }, { creator_uid: "u" }, { worker_id: "w" }, { share_dir: "mine" }, { local_only: true }, { color: "r" }, { tag: "x" },
    { media_type: "video" }, { review_filter: "held" }, { shared_only: true }, { comment_only: true }, { final_only: true },
    { colors: ["r"] }, { tags: ["x"] }, { auto_tags: ["y"] },
  ];
  for (const change of finds) {
    const query = { ...base, ...change };
    expect([change, folderCardsPlace(query), hasFindFilters(query, false)]).toEqual([change, { projectId: "p1", parent: "e035" }, true]);
  }
  expect([hasFindFilters(base, false), hasFindFilters(base, true)]).toEqual([false, true]); // 회색 숨김도 찾는 조건
  expect(hasFindFilters({ ...base, workspace_ids: ["ws-1"] }, false)).toBe(false); // 팀 공간 하나는 자리의 일부(서버가 같은 식으로 거른다)
  const noPlace: Partial<GenQuery>[] = [
    { tab: "my" }, { project_id: undefined }, { project_id: "none" }, { include_deleted: true }, { deleted_only: true },
    { workspace_ids: ["ws-1", "ws-2"] }, { workspace_scope: "personal" },
  ];
  for (const change of noPlace) expect([change, folderCardsPlace({ ...base, ...change })]).toEqual([change, null]);
});

it("부모 폴더와 팀 공간 하나", () => {
  expect([parentFolder("e035/C0010/takeB"), parentFolder("e035/C0010"), parentFolder("e035")]).toEqual(["e035/C0010", "e035", ""]);
  expect(singleTeamWorkspace({ ...base, workspace_ids: ["ws-1"] })).toBe("ws-1");
  expect(singleTeamWorkspace({ ...base, workspace_ids: ["a", "b"] })).toBeUndefined();
  expect(singleTeamWorkspace({ ...base, workspace_ids: ["ws-1"], workspace_scope: "personal" })).toBeUndefined();
  expect(singleTeamWorkspace(base)).toBeUndefined();
});

// ── 받기 ──
type HookProps = { scope: FolderCardsScope | null; authKey?: string; reloadKey?: number };
let root: Root;
let host: HTMLDivElement;
let seen: ReturnType<typeof useFolderCards>;
function Harness({ scope, authKey = "account-a", reloadKey = 0 }: HookProps) {
  seen = useFolderCards({ scope, authKey, reloadKey });
  return null;
}
const show = (props: HookProps) => act(() => root.render(<Harness {...props} />));
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const hold = () => {
  let release!: (value: FolderCards) => void;
  let fail!: (error: unknown) => void;
  folderCardsApi.mockImplementationOnce(() => new Promise<FolderCards>((resolve, reject) => { release = resolve; fail = reject; }));
  return { release: (value: FolderCards) => act(async () => { release(value); }), fail: (error: unknown) => act(async () => { fail(error); }) };
};
const e035: FolderCardsScope = { projectId: "p1", parent: "e035" };

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  folderCardsApi.mockReset();
  folderCardsApi.mockResolvedValue(cards());
  forgetFolderCards(); // 받아 둔 카드의 기억은 모듈에 있다 — 시험끼리 섞이지 않게
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

it("범위가 없으면 받지 않고, 생기면 받는다 — 목록이 새로 들어올 때마다(reloadKey) 다시 받는다", async () => {
  show({ scope: null });
  await settle();
  expect(folderCardsApi).not.toHaveBeenCalled();
  expect(seen.cards).toBeNull();

  folderCardsApi.mockResolvedValue(cards(card("C0010", 8)));
  show({ scope: { ...e035, workspaceId: "ws-1" } });
  await settle();
  expect(folderCardsApi).toHaveBeenLastCalledWith("p1", "e035", "ws-1");
  expect(seen.cards?.folders.map((folder) => folder.name)).toEqual(["C0010"]);

  folderCardsApi.mockResolvedValue(cards(card("C0010", 8, true)));
  show({ scope: { ...e035, workspaceId: "ws-1" }, reloadKey: 1 }); // 대표만 바뀐 경우 — 목록 내용은 그대로여도 다시 받는다
  await settle();
  expect(folderCardsApi).toHaveBeenCalledTimes(2);
  expect(seen.cards?.folders[0].rep).toBe(true);
});

it("문맥이 바뀌면 받아 둔 카드를 곧바로 버리고, 늦게 온 옛 응답도 그리지 않는다", async () => {
  folderCardsApi.mockResolvedValue(cards(card("C0010", 8)));
  show({ scope: e035 });
  await settle();
  expect(seen.cards).not.toBeNull();

  // 다른 폴더 — 새 응답이 오기 전에도 옛 폴더의 카드는 보이지 않는다
  const slowOld = hold();
  show({ scope: e035, reloadKey: 1 }); // 옛 폴더의 다시 받기가 출발
  const next = hold();
  show({ scope: { projectId: "p1", parent: "e036" }, reloadKey: 1 });
  expect(seen.cards).toBeNull();
  await next.release({ parent: "e036", own_count: 0, folders: [card("C0900", 1)] });
  expect(seen.cards?.parent).toBe("e036");
  await slowOld.release(cards(card("LATE", 99))); // 늦게 도착한 옛 폴더 응답
  expect(seen.cards?.parent).toBe("e036");

  // 계정·서버가 바뀌어도 같다 — 같은 폴더를 보고 있어도 남의 문맥의 카드는 남지 않는다
  hold();
  show({ scope: { projectId: "p1", parent: "e036" }, reloadKey: 1, authKey: "account-b" });
  expect(seen.cards).toBeNull();
});

it("옛 공유 서버(경로 없음)는 그 계정·서버에서만 '지원 안 함' 으로 기억하고, 다른 오류는 기억하지도 카드를 지우지도 않는다", async () => {
  folderCardsApi.mockResolvedValue(cards(card("C0010", 8)));
  show({ scope: e035 });
  await settle();

  folderCardsApi.mockRejectedValueOnce(new HttpError(502, "502: 공유 서버 연결 실패", "공유 서버 연결 실패"));
  show({ scope: e035, reloadKey: 1 });
  await settle();
  expect(seen.unsupported).toBe(false);
  expect(seen.cards?.folders).toHaveLength(1); // 받아 둔 카드는 그대로
  folderCardsApi.mockRejectedValueOnce(new HttpError(404, "404: 이 폴더에서 볼 수 있는 공유물이 아닙니다", "이 폴더에서 볼 수 있는 공유물이 아닙니다"));
  show({ scope: e035, reloadKey: 2 });
  await settle();
  expect(seen.unsupported).toBe(false); // 업무상의 404 는 옛 서버가 아니다

  folderCardsApi.mockRejectedValueOnce(new HttpError(404, "404: Not Found", "Not Found"));
  show({ scope: e035, reloadKey: 3 });
  await settle();
  expect(seen.unsupported).toBe(true);
  expect(seen.cards).toBeNull(); // 받아 뒀던 카드도 내놓지 않는다 — 낡은 묶음 화면이 돌아갈 길 없이 남지 않게
  const calls = folderCardsApi.mock.calls.length;
  show({ scope: e035, reloadKey: 4 });
  await settle();
  expect(folderCardsApi).toHaveBeenCalledTimes(calls); // 다시 묻지 않는다

  show({ scope: e035, reloadKey: 4, authKey: "other-server" }); // 서버를 바꾸면 다시 묻는다
  await settle();
  expect(seen.unsupported).toBe(false);
  expect(folderCardsApi).toHaveBeenCalledTimes(calls + 1);
});

// 2026-10-13 ③(Jay): 폴더를 옮기면 묶음 응답 전에 낱장이 한 번 보였다 — App 이 loading 동안 낱장 격자를 그리지 않는다.
it("loading — 새 문맥의 첫 응답 전엔 true, 받아 둔 카드가 있는 문맥은 false, 실패하면 false(실패 표식은 문맥을 떠나면 버린다), 옛 서버는 false", async () => {
  show({ scope: null });
  expect(seen.loading).toBe(false); // 받을 것이 없다
  const first = hold();
  show({ scope: e035 });
  expect(seen.loading).toBe(true); // 첫 렌더부터 — 효과가 돌기 전에도
  await first.release(cards(card("C0010", 8)));
  expect(seen.loading).toBe(false);
  const again = hold();
  show({ scope: e035, reloadKey: 1 }); // 같은 문맥의 다시 받기(주기 조회) — 올리지 않는다
  expect([seen.loading, seen.cards?.folders.length]).toEqual([false, 1]);
  await again.release(cards(card("C0010", 8)));

  const other = hold();
  show({ scope: { projectId: "p1", parent: "e036" }, reloadKey: 1 });
  expect([seen.loading, seen.cards]).toEqual([true, null]);
  await other.fail(new HttpError(502, "502: 공유 서버 연결 실패", "공유 서버 연결 실패"));
  expect([seen.loading, seen.cards, seen.unsupported]).toEqual([false, null, false]); // 실패 — 낱장으로(영영 빈 화면이 아니다)
  // 받아 둔 카드가 있는 문맥으로 돌아오면 바로 그 카드(다시 받기는 뒤에서)
  const back = hold();
  show({ scope: e035, reloadKey: 1 });
  expect([seen.loading, seen.cards?.parent]).toEqual([false, "e035"]);
  await back.release(cards(card("C0010", 8)));
  // 실패했던 문맥으로 되돌아오면 다시 기다린다 — 실패 표식을 남기면 첫 렌더부터 낱장이 선다(Codex 설계 검토)
  const retry = hold();
  show({ scope: { projectId: "p1", parent: "e036" }, reloadKey: 1 });
  expect(seen.loading).toBe(true);
  await retry.release({ parent: "e036", own_count: 0, folders: [] });
  expect([seen.loading, seen.cards?.folders]).toEqual([false, []]);
  // 옛 서버(경로 없음) — 기다리지 않는다
  folderCardsApi.mockRejectedValueOnce(new HttpError(404, "404: Not Found", "Not Found"));
  show({ scope: { projectId: "p1", parent: "e037" }, reloadKey: 1 });
  expect(seen.loading).toBe(true);
  await settle();
  expect([seen.loading, seen.unsupported]).toEqual([false, true]);
});

// 2026-10-13(Jay "아직 폴더 이동할 때 딜레이"): 다시 온 폴더는 받아 둔 카드부터, 하위 폴더가 없다고 알려 준 컷은 물어보기 전에 답(빈 묶음)을 안다.
it("받아 둔 카드를 기억한다 — 다시 온 폴더는 응답 전에 그 카드, 하위 폴더 없는 컷은 미리 '빈 묶음', 훅 둘이 같이 쓴다. 조회는 늘 다시 보낸다", async () => {
  const leaf = { ...card("C0010", 8), subfolders: 0 };
  const deep = { ...card("C0040", 14), subfolders: 3 };
  const old = card("C0090", 2); // 옛 서버 — subfolders 없음: 미리 적지 않는다
  folderCardsApi.mockResolvedValueOnce(cards(leaf, deep, old));
  show({ scope: e035 });
  await settle();
  const first = seen.cards;
  // 컷(잎)으로 — 응답 전부터 빈 묶음(기다리지 않는다). 조회는 그래도 간다
  const real = hold();
  show({ scope: { projectId: "p1", parent: "e035/C0010" } });
  expect([seen.loading, seen.cards]).toEqual([false, { parent: "e035/C0010", own_count: 8, folders: [] }]);
  expect(folderCardsApi).toHaveBeenLastCalledWith("p1", "e035/C0010", undefined);
  const seeded = seen.cards;
  await real.release({ parent: "e035/C0010", own_count: 8, folders: [] });
  expect(seen.cards).toBe(seeded); // 답이 미리 적은 것과 같다 — 같은 객체(다시 그리지 않는다)
  // 하위 폴더가 있는 컷·옛 서버의 카드는 미리 모른다 — 기다린다
  for (const name of ["C0040", "C0090"]) {
    const wait = hold();
    show({ scope: { projectId: "p1", parent: `e035/${name}` } });
    expect([name, seen.loading, seen.cards]).toEqual([name, true, null]);
    await wait.release({ parent: `e035/${name}`, own_count: 0, folders: [] });
  }
  // 에피소드로 돌아오면 응답 전부터 받아 둔 카드(같은 객체), 답이 오면 바뀐다
  const again = hold();
  show({ scope: e035 });
  expect([seen.loading, seen.cards]).toEqual([false, first]);
  expect(seen.cards).toBe(first);
  // 그사이 C0010 에 하위 폴더가 생겼다 → 미리 적은 '빈 묶음'은 지운다(다음에 들어가면 기다린다)
  await again.release(cards({ ...leaf, subfolders: 2 }, deep, old));
  expect(seen.cards?.folders[0].subfolders).toBe(2);
  const grown = hold();
  show({ scope: { projectId: "p1", parent: "e035/C0010" } });
  expect([seen.loading, seen.cards]).toEqual([true, null]);
  await grown.release({ parent: "e035/C0010", own_count: 0, folders: [card("takeB", 8)] });
  // 다른 계정·공간은 기억을 같이 쓰지 않는다
  hold();
  show({ scope: e035, authKey: "account-b" });
  expect([seen.loading, seen.cards]).toEqual([true, null]);
  hold();
  show({ scope: { ...e035, workspaceId: "ws-1" } });
  expect([seen.loading, seen.cards]).toEqual([true, null]);
});

it("reload 는 서버 값을 다시 읽고 끝난 뒤에 풀린다 — 그 앞에 출발한 조회는 버리고 그 뒤 한 번만 더 보낸다(같은 문맥은 합친다)", async () => {
  const early = hold();
  show({ scope: e035 }); // 저장 전에 출발한 조회(받는 중)
  folderCardsApi.mockResolvedValueOnce(cards(card("C0010", 8, true))); // 그 뒤의 조회가 받을 값
  let done = false;
  let waiting!: Promise<void>;
  act(() => { waiting = seen.reload().then(() => { done = true; }); });
  await settle();
  expect(folderCardsApi).toHaveBeenCalledTimes(1); // 받는 중이면 새로 보내지 않는다
  expect(done).toBe(false);
  await early.release(cards(card("C0010", 8, false))); // 저장 전 값 — 버린다(끝나자 한 번 더 받아 그 값이 보인다)
  await settle();
  expect(seen.cards?.folders[0].rep).not.toBe(false);
  expect(folderCardsApi).toHaveBeenCalledTimes(2);
  await act(async () => { await waiting; });
  expect(done).toBe(true);
  expect(seen.cards?.folders[0].rep).toBe(true);

  folderCardsApi.mockRejectedValueOnce(new Error("network"));
  await act(async () => { await seen.reload(); }); // 실패해도 던지지 않는다(잠금을 푸는 쪽이 기다린다)
  expect(seen.cards?.folders[0].rep).toBe(true);
});

it("같은 문맥의 요구가 받는 중에 여러 번 와도 조회는 그 뒤 한 번뿐 — 내용이 같은 응답은 같은 객체를 돌려준다", async () => {
  folderCardsApi.mockResolvedValue(cards(card("C0010", 8)));
  show({ scope: e035 });
  await settle();
  const first = seen.cards;
  const slow = hold();
  show({ scope: e035, reloadKey: 1 }); // 주기 조회 — 받는 중
  show({ scope: e035, reloadKey: 2 }); // 그사이 또
  show({ scope: e035, reloadKey: 3 });
  expect(folderCardsApi).toHaveBeenCalledTimes(2);
  await slow.release(cards(card("C0010", 8)));
  await settle();
  expect(folderCardsApi).toHaveBeenCalledTimes(3); // 합쳐진 요구는 한 번으로
  expect(seen.cards).toBe(first); // 내용이 같다 — 같은 객체(아래가 다시 그리지 않는다)
  folderCardsApi.mockResolvedValue(cards(card("C0010", 8, true)));
  show({ scope: e035, reloadKey: 4 });
  await settle();
  expect(seen.cards).not.toBe(first);
  expect(seen.cards?.folders[0].rep).toBe(true);
});

it("저장 뒤의 재조회에 주기 조회가 얹히면 저장 응답은 버리지 않고 적용하고 저장은 바로 풀린다 — 그 뒤 한 번 더 받는다", async () => {
  folderCardsApi.mockResolvedValue(cards(card("C0010", 8)));
  show({ scope: e035 });
  await settle();
  const mine = hold(); // 저장 뒤의 재조회
  let done = false;
  let waiting!: Promise<void>;
  act(() => { waiting = seen.reload().then(() => { done = true; }); });
  const later = hold(); // 목록이 새로 들어와(reloadKey) — 받는 중인 저장 조회에 얹힌다(새로 보내지 않는다)
  show({ scope: e035, reloadKey: 1 });
  expect(folderCardsApi).toHaveBeenCalledTimes(2);
  await mine.release(cards(card("C0010", 8, true))); // 저장 뒤 값 — 적용된다
  await act(async () => { await waiting; });
  expect(done).toBe(true);
  expect(seen.cards?.folders[0].rep).toBe(true);
  expect(folderCardsApi).toHaveBeenCalledTimes(3); // 얹힌 주기 조회가 한 번 더
  await later.release(cards(card("C0010", 8, true)));
  expect(seen.cards?.folders[0].rep).toBe(true);
});

it("저장 뒤 다른 폴더로 갔다 돌아오면 버려진 저장 조회는 돌아온 폴더의 조회가 끝날 때 풀린다 — 옛 값 표시로 잠금을 풀지 않는다", async () => {
  folderCardsApi.mockResolvedValue(cards(card("C0010", 8)));
  show({ scope: e035 });
  await settle();
  const mine = hold(); // 저장 뒤의 재조회(A)
  let done = false;
  act(() => { void seen.reload().then(() => { done = true; }); });
  const b = hold();
  show({ scope: { projectId: "p1", parent: "e036" } }); // B 로
  const back = hold();
  show({ scope: e035 }); // 다시 A 로 — 새 조회
  await mine.release(cards(card("C0010", 8, false))); // 버려지는 저장 전 값
  await settle();
  expect(done).toBe(false); // 돌아온 A 의 조회가 끝나기 전에는 풀리지 않는다
  await b.release({ parent: "e036", own_count: 0, folders: [] });
  await settle();
  expect(done).toBe(false);
  await back.release(cards(card("C0010", 8, true)));
  await settle();
  expect(done).toBe(true);
  expect(seen.cards?.folders[0].rep).toBe(true);
});

it("옛 문맥의 조회가 끝나며 새 문맥에 얹힌 요구를 가져가지 않는다 — 새 문맥의 조회가 끝날 때 그 뒤 한 번 더 받아 풀린다", async () => {
  const slowA = hold();
  show({ scope: e035 }); // A 받는 중
  const b = hold();
  show({ scope: { projectId: "p1", parent: "e036" } }); // B 로 전환 — 바로 보낸다
  expect(folderCardsApi).toHaveBeenCalledTimes(2);
  const afterSave = hold();
  let done = false;
  act(() => { void seen.reload().then(() => { done = true; }); }); // B 에서 저장 뒤 — B 응답은 버리고 얹힌다
  await slowA.release(cards(card("LATE", 1))); // 옛 문맥 A 가 끝난다 — B 의 얹힌 요구를 가져가면 안 된다
  await settle();
  expect(done).toBe(false);
  expect(folderCardsApi).toHaveBeenCalledTimes(2);
  await b.release({ parent: "e036", own_count: 0, folders: [card("OLD", 1)] }); // 버려지는 응답
  await settle();
  expect(folderCardsApi).toHaveBeenCalledTimes(3); // B 가 끝나자 한 번 더
  await afterSave.release({ parent: "e036", own_count: 0, folders: [card("NEW", 1, true)] });
  await settle();
  expect(done).toBe(true);
  expect(seen.cards?.folders[0].name).toBe("NEW");
});

// ── 컷 카드 격자 ──
const gridProps = {
  scale: 1, fill: true, layout: "grid" as const, table: false, selected: new Set<string>(), onSelect: () => {}, onInfo: () => {}, onReel: () => {},
  onPreview: () => {}, onShowAll: () => {}, onEnter: () => {}, onOpen: () => {}, top: false,
};
const dbl = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });

it("폴더마다 카드 한 장 — 이름·건수, 대표가 없으면 '대표 미정', 영상이면 재생 표시. 컷을 두 번 누르면 모아보기", () => {
  const opened: string[] = [];
  const folders = [card("C0010", 8, true), card("C0040", 14, false, "video")];
  const showAll = vi.fn();
  const draw = (outside: number, shown: FolderCard[] = folders) => act(() => root.render(
    <FolderCardGrid {...gridProps} folders={shown} onReel={(paths) => opened.push(...paths)} outside={outside} onShowAll={showAll} />,
  ));
  draw(0);

  const tiles = [...host.querySelectorAll<HTMLButtonElement>(".cut-grid .cut-card")];
  expect(tiles).toHaveLength(2); // 고른 폴더에 직접 든 것이 없으면 '컷 밖' 칸도 없다
  expect(tiles.map((tile) => tile.querySelector(".cut-tab")!.textContent)).toEqual(["C00108", "C004014"]);
  expect(tiles.map((tile) => tile.querySelector(".cut-pill")?.textContent ?? null)).toEqual([null, "대표 미정"]);
  expect(tiles.map((tile) => !!tile.querySelector(".play-badge"))).toEqual([false, true]);
  expect(tiles[0].querySelector("img")!.getAttribute("src")).toContain("cover-C0010");
  // 표지 그림이 깨진 뒤 대표가 바뀌면 다시 보인다(생성물 카드와 같은 분기 — 숨긴 채 남지 않는다)
  act(() => { tiles[0].querySelector("img")!.dispatchEvent(new Event("error")); });
  expect(tiles[0].querySelector("img")).toBeNull();
  draw(0, [{ ...folders[0], cover: cover("cover-C0010-new") }, folders[1]]);
  expect(tiles[0].querySelector("img")!.getAttribute("src")).toContain("cover-C0010-new");
  // 포스터 없는 원격 영상은 첫 프레임(영상 요소)으로
  const bare = { ...card("C0900", 1, false, "video"), cover: { ...cover("bare", "video"), assets: [{ type: "video", file_path: "https://cdn.invalid/bare.mp4" }] } as unknown as Generation };
  draw(0, [bare]);
  const face = host.querySelector(".cut-face")!;
  expect(face.querySelector("img")).toBeNull();
  expect(face.querySelector("video")!.getAttribute("src")).toBe("https://cdn.invalid/bare.mp4");
  draw(0, folders);
  // 키가 바뀐 카드는 새로 그려진다 — 다시 찾는다
  const second = host.querySelectorAll<HTMLButtonElement>(".cut-grid .cut-card")[1];
  expect(second.title).toBe("e035/C0040 · 14건");
  expect(host.querySelector<HTMLElement>(".cut-grid")!.tabIndex).toBe(-1); // 창을 닫은 뒤 초점을 돌려받는 자리
  expect(host.querySelector<HTMLElement>(".cut-grid")!.style.gridTemplateColumns).toBe("repeat(auto-fill, minmax(180px, 1fr))");

  act(() => second.click());
  expect(opened).toEqual([]); // 한 번 클릭은 고르기
  dbl(second);
  expect(opened).toEqual(["e035/C0040"]);

  // 고른 폴더에 직접 든 것 — 어느 카드에도 들지 않아 맨 끝 칸으로 알리고, 누르면 한 장씩 보기로 간다
  draw(3);
  const last = [...host.querySelectorAll<HTMLButtonElement>(".cut-grid .cut-card")].at(-1)!;
  expect(last.classList.contains("cut-out")).toBe(true);
  expect(last.querySelector(".cut-out-count")!.textContent).toBe("컷 밖 3건");
  act(() => last.click());
  expect(showAll).toHaveBeenCalledTimes(1);
  expect(opened).toEqual(["e035/C0040"]);
});

// 2026-10-13 낮(Jay): 컷 두 번 클릭 = 모아보기(아침엔 '들어가기', 그 전엔 창). 들어가기는 하위 폴더가 있는 카드(에피소드)만.
it("두 번 클릭은 하위 폴더가 있으면(에피소드) 그 폴더로 들어가고, 없으면(컷·옛 서버) 모아보기. 맨 위에서는 '에피소드 밖'", () => {
  const entered: string[] = [];
  const reels: string[][] = [];
  const episode: FolderCard = { ...card("e035", 14), path: "e035", subfolders: 5 };
  const leaf: FolderCard = { ...card("e036", 2), path: "e036", subfolders: 0 };
  const old: FolderCard = { ...card("e037", 1), path: "e037" }; // 옛 서버 — subfolders 없음 = 잎
  act(() => root.render(
    <FolderCardGrid {...gridProps} folders={[episode, leaf, old]} top onEnter={(f) => entered.push(f.path)} onReel={(paths) => reels.push(paths)} outside={2} />,
  ));
  const tile = (path: string) => host.querySelector<HTMLElement>(`.cut-card[data-path="${path}"]`)!;
  // 하위 폴더를 가진 카드가 하나라도 있는 단계 = 에피소드 화면 — 카드 모양이 다르다(이름은 표지 위에)
  expect(host.querySelector(".cut-grid")!.className).toBe("cut-grid ep-board ep-grid");
  expect(tile("e035").querySelector(".ep-cap")!.textContent).toBe("e035컷 5 · 14건");
  expect(tile("e036").querySelector(".ep-cap")!.textContent).toBe("e0362건");
  expect(tile("e035").title).toBe("e035 · 컷 5 · 14건");
  dbl(tile("e035"));
  dbl(tile("e036"));
  dbl(tile("e037"));
  expect([entered, reels]).toEqual([["e035"], [["e036"], ["e037"]]]);
  expect(host.querySelector(".cut-out-count")!.textContent).toBe("에피소드 밖 2건");
});

// ── 고르기 — 한 번 클릭·Ctrl·Shift·빈 곳에서 끌기·휠 클릭 ──
// 끄는 중의 움직임은 단추가 눌려 있다(buttons 1) — 단추 없는 움직임은 끌기의 끝이다(lib/windowDrag)
const mouse = (type: string, el: EventTarget, init: MouseEventInit = {}) =>
  act(() => { el.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, buttons: type === "mousemove" ? 1 : 0, ...init })); });

// ── 에피소드 화면(2026-10-13) — 모양만 다르다: 리스트 = 한 줄에 하나, 그리드 = 컷 띠가 붙은 카드. 고르기·두 번 클릭·키는 같은 격자의 것 ──
it("에피소드 화면: 리스트는 한 줄에 하나·그리드는 폭에 맞춰 채운다. 카드 안 단추(컷 띠·[열기])는 고르기를 바꾸지 않고 제 일을 한다", () => {
  const entered: FolderCard[] = [];
  let selected = new Set<string>();
  const cuts = ["C0010", "C0020"].map((name) => ({ path: "e035/" + name, name, count: 3, rep: name === "C0010", cover: { id: "c-" + name, assets: [] } }));
  const episode: FolderCard = { ...card("e035", 14), path: "e035", subfolders: 9, rep_count: 1, video_count: 4, children: cuts };
  const other: FolderCard = { ...card("e036", 2), path: "e036", subfolders: 1, children: [] };
  let layout: "list" | "grid" = "list";
  const draw = () => act(() => root.render(
    <FolderCardGrid {...gridProps} layout={layout} scale={1.2} folders={[episode, other]} top selected={selected}
      onEnter={(folder) => entered.push(folder)} onSelect={(next) => { selected = next; draw(); }} outside={2} />,
  ));
  draw();
  const grid = () => host.querySelector<HTMLElement>(".cut-grid")!;
  const tile = () => host.querySelector<HTMLElement>('.cut-card[data-path="e035"]')!;
  expect([grid().className, grid().style.gridTemplateColumns, grid().style.getPropertyValue("--ep-scale")]).toEqual(["cut-grid ep-board ep-list", "minmax(0, 1fr)", "1.2"]);
  // 번호는 이름의 숫자 그대로(035) — 번호 칸은 가장 긴 번호에 맞춘다(세 자리 = 66px·30px)
  expect([host.querySelector(".ep-num")!.textContent, grid().style.getPropertyValue("--ep-num-w"), grid().style.getPropertyValue("--ep-num-size")]).toEqual(["035", "66px", "30px"]);
  // 카드는 같은 .cut-card[data-path] — 안에 단추가 들어 있어 div(role=button)다
  expect([tile().tagName, tile().getAttribute("role"), tile().tabIndex, tile().className]).toEqual(["DIV", "button", 0, "cut-card ep-card ep-list"]);
  expect(host.querySelector(".cut-out-count")!.textContent).toBe("에피소드 밖 2건");

  // 컷 띠의 컷 — 누름이 카드 고르기로 읽히지 않고 그 컷으로 들어간다(사이드바에서 그 컷을 누른 것과 같은 길)
  const cutButton = tile().querySelector<HTMLButtonElement>(".ep-cut")!;
  mouse("mousedown", cutButton);
  mouse("mouseup", window);
  act(() => cutButton.click());
  expect(selected.size).toBe(0);
  expect(entered.map((folder) => [folder.path, folder.name, folder.subfolders])).toEqual([["e035/C0010", "C0010", 0]]);
  dbl(cutButton); // 그 단추를 빠르게 두 번 눌러도 카드의 두 번 클릭(에피소드로 들어가기)이 아니다
  expect(entered.length).toBe(1);
  // 단추에 초점이 있을 때의 Enter·Space 는 그 단추의 키다 — 격자가 카드를 열거나 고르지 않는다
  cutButton.focus();
  for (const key of ["Enter", " "]) act(() => { cutButton.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
  expect([entered.length, selected.size]).toEqual([1, 0]);
  // '+N' · [열기] = 그 에피소드로
  act(() => tile().querySelector<HTMLButtonElement>(".ep-cut.more")!.click());
  act(() => tile().querySelector<HTMLButtonElement>(".ep-enter")!.click());
  expect(entered.slice(1).map((folder) => folder.path)).toEqual(["e035", "e035"]);

  // 카드 자체는 전과 같다 — 한 번 클릭 = 고르기, 두 번 클릭 = 들어가기
  mouse("mousedown", tile().querySelector(".ep-name")!);
  mouse("mouseup", window);
  expect([[...selected], tile().classList.contains("sel"), tile().getAttribute("aria-pressed")]).toEqual([["e035"], true, "true"]);
  dbl(tile().querySelector(".ep-name")!);
  expect(entered.length).toBe(4);

  layout = "grid";
  draw();
  expect([grid().className, grid().style.gridTemplateColumns]).toEqual(["cut-grid ep-board ep-grid", "repeat(auto-fill, minmax(408px, 1fr))"]); // 340 × 크기 1.2
  expect(tile().className).toBe("cut-card ep-card ep-grid sel");
  expect(tile().querySelector(".ep-enter")).toBeNull(); // 그리드에는 [열기] 가 없다
});

// Codex 코드 리뷰: 카드 안 단추는 격자의 누름 처리에서 빠지므로(고르기를 안 바꾸려고), 위에 뜬 메뉴를 닫는 누름이 그대로 컷으로 들어갔다 —
//  화면 위치와 생성 위치까지 바뀐다. 누름의 시작에 가려져 있었으면 그 단추의 click 을 실행하지 않는다.
it("에피소드 화면: 위에 뜬 메뉴를 닫는 누름은 카드 안 단추(컷 띠·[열기])를 실행하지 않는다 — 키보드로 누른 것은 그 순간의 가림을 본다", async () => {
  const entered: string[] = [];
  const cuts = [{ path: "e035/C0010", name: "C0010", count: 3, rep: false, cover: { id: "c", assets: [] } }];
  const episode: FolderCard = { ...card("e035", 14), path: "e035", subfolders: 4, children: cuts };
  act(() => root.render(<FolderCardGrid {...gridProps} layout="list" folders={[episode]} top onEnter={(folder) => entered.push(folder.path)} outside={0} />));
  const cutButton = () => host.querySelector<HTMLButtonElement>(".ep-cut")!;
  const { useKeyOwner } = await import("../src/lib/keyGate");
  function Owner({ on }: { on: boolean }) { useKeyOwner(on); return null; }
  const owner = createRoot(document.body.appendChild(document.createElement("div")));
  const mouseClick = (el: HTMLElement) => act(() => { el.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })); });
  // 메뉴가 떠 있는 채 시작한 누름 — 메뉴는 누름의 앞쪽(pointerdown)에 닫혀 click 때는 이미 없다. 들어가지 않는다
  act(() => owner.render(<Owner on />));
  act(() => { cutButton().dispatchEvent(new Event("pointerdown", { bubbles: true })); });
  act(() => owner.render(<Owner on={false} />));
  mouse("mousedown", cutButton());
  act(() => { cutButton().dispatchEvent(new Event("pointerup", { bubbles: true })); });
  mouse("mouseup", window);
  mouseClick(cutButton());
  expect(entered).toEqual([]);
  // 그다음의 보통 누름은 들어간다(기록이 남아 다음 누름을 삼키지 않는다)
  act(() => { cutButton().dispatchEvent(new Event("pointerdown", { bubbles: true })); });
  mouse("mousedown", cutButton());
  act(() => { cutButton().dispatchEvent(new Event("pointerup", { bubbles: true })); });
  mouse("mouseup", window);
  mouseClick(cutButton());
  expect(entered).toEqual(["e035/C0010"]);
  // 키보드로 누른 것(Enter·Space 의 click — detail 0): 위에 창이 떠 있으면 쉬고, 없으면 들어간다
  const enter = host.querySelector<HTMLButtonElement>(".ep-enter")!;
  act(() => owner.render(<Owner on />));
  act(() => enter.click());
  expect(entered).toHaveLength(1);
  act(() => owner.render(<Owner on={false} />));
  act(() => enter.click());
  expect(entered).toEqual(["e035/C0010", "e035"]);
  act(() => owner.unmount());
});

// 조작 규칙 61(33회차): 브라우저는 연속 누름 수를 시간·거리로만 센다 — 줄 안의 [열기]를 습관대로 두 번 누르면 둘째 누름(detail 2)이 들어간
//  화면의 **같은 자리**에 mousedown·click·dblclick 으로 닿는다(헤드리스 크롬 실측). 리스트에서는 그 자리가 컷 줄의 [폴더로]라 두 단계를
//  들어갔고, 줄의 몸통이면 그 컷이 골라지고 모아보기가 열렸다. 첫 누름 뒤로 자리가 바뀐 둘째 누름은 버린다.
it("두 번 누름: 첫 누름([열기])이 자리를 옮기면 둘째 누름은 들어간 화면에서 아무 일도 하지 않는다 — 같은 자리의 두 번 클릭은 그대로", () => {
  const entered: string[] = [];
  const reels: string[][] = [];
  let selected = new Set<string>();
  const episode: FolderCard = { ...card("e035", 14), path: "e035", subfolders: 2, children: [] };
  const cuts: FolderCard[] = [{ ...card("C0010", 3), subfolders: 0 }, { ...card("C0020", 5), subfolders: 0 }];
  let screen: { place: string; folders: FolderCard[]; top: boolean } = { place: "p1", folders: [episode], top: true };
  const draw = () => act(() => root.render(
    <FolderCardGrid {...gridProps} layout="list" folders={screen.folders} top={screen.top} placeKey={screen.place} selected={selected}
      onSelect={(next) => { selected = next; draw(); }} onEnter={(folder) => entered.push(folder.path)} onReel={(paths) => reels.push(paths)} outside={0} />,
  ));
  draw();
  const enter = () => host.querySelector<HTMLButtonElement>(".ep-enter")!; // 맨 위 줄의 단추 — 에피소드 줄은 [열기], 컷 줄은 [폴더로]
  const body = () => host.querySelector<HTMLElement>('.cut-card[data-path="e035/C0010"] .ep-name')!;
  // 브라우저의 순서 그대로: mousedown → mouseup → click, 둘째 누름이면 dblclick 까지
  const press = (el: HTMLElement, detail: number) => {
    mouse("mousedown", el, { detail });
    mouse("mouseup", window, { detail });
    mouse("click", el, { detail });
    if (detail === 2) mouse("dblclick", el, { detail });
  };

  press(enter(), 1); // 첫 누름 — 에피소드로 들어간다
  expect(entered).toEqual(["e035"]);
  screen = { place: "p1/e035", folders: cuts, top: false }; // 들어간 화면 — 같은 자리에 컷 줄이 서 있다
  draw();
  expect(enter().textContent).toContain("폴더로");
  press(enter(), 2); // 둘째 누름이 그 자리의 [폴더로]에 닿는다
  expect(entered).toEqual(["e035"]); // 두 단계를 들어가지 않는다
  press(body(), 2); // 줄의 몸통에 닿은 경우 — 고르지도, 모아보기를 열지도 않는다
  expect([[...selected], reels]).toEqual([[], []]);

  // 이 화면에서 새로 시작한 누름은 전과 같다: 한 번 = 고르기 · 같은 줄을 두 번 = 모아보기 · [폴더로] = 들어가기
  press(body(), 1);
  expect([...selected]).toEqual(["e035/C0010"]);
  press(body(), 2);
  expect(reels).toEqual([["e035/C0010"]]);
  press(enter(), 1);
  expect(entered).toEqual(["e035", "e035/C0010"]);
});

// 2026-10-13 오후(Jay): 컷 화면도 리스트를 누르면 다르게 — 한 번 = 프로젝트 화면과 같은 줄(띠에는 그 컷의 생성물), 한 번 더(table) = 표.
//  그리드는 겹친 종이 카드 그대로다. 줄·표의 줄도 같은 .cut-card[data-path] 라 고르기·두 번 클릭(모아보기)·키는 격자의 것 그대로.
it("컷 화면: 그리드는 겹친 종이 카드 그대로 · 리스트 = 줄(생성물 띠 = 크게 보기, [폴더로] = 그 컷으로) · 리스트 한 번 더 = 표", () => {
  const take = (id: string, extra: object = {}) =>
    ({ cover: { id, assets: [{ id: "a-" + id, type: "video", file_path: `/m/${id}.mp4`, thumbnail_path: `/m/${id}.png` }] }, final: false, held: false, by: "리버", ...extra });
  const takes = Array.from({ length: 10 }, (_, index) => take("t" + index, index === 1 ? { final: true } : index === 2 ? { held: true, by: null } : {}));
  takes[5] = { ...takes[5], cover: { id: "t5", assets: [] } }; // 그림이 없는 것 — 띠에는 칸이 서지만 크게 보기의 넘겨 보기에서는 빠진다
  const cut: FolderCard = {
    ...card("C0010", 14), rep: true, cover: { ...card("C0010", 14).cover, id: "t0" }, subfolders: 0, video_count: 13, final_count: 2, held_count: 1,
    last_shared_at: null, workers: [{ name: "리버", count: 12 }, { name: null, count: 2 }], takes,
  } as FolderCard;
  const old = card("C0020", 2); // 옛 공유 서버 — 새 집계가 없다
  const entered: string[] = [];
  const reels: string[][] = [];
  const previews: Array<{ url: string; index?: number; items?: Array<{ genId?: string }> }> = [];
  let selected = new Set<string>();
  let view: { layout: "list" | "grid"; table: boolean } = { layout: "grid", table: true };
  const draw = () => act(() => root.render(
    <FolderCardGrid {...gridProps} {...view} folders={[cut, old]} selected={selected} onSelect={(next) => { selected = next; draw(); }}
      onEnter={(folder) => entered.push(folder.path)} onReel={(paths) => reels.push(paths)} onPreview={(target) => previews.push(target)} outside={0} />,
  ));
  const grid = () => host.querySelector<HTMLElement>(".cut-grid")!;
  const row = (name: string) => host.querySelector<HTMLElement>(`.cut-card[data-path="e035/${name}"]`)!;

  // 그리드 — 겹친 종이 카드(리스트 단추의 두 번째 상태(table)는 그리드에 아무 영향이 없다)
  draw();
  expect([grid().className, grid().style.gridTemplateColumns, row("C0010").tagName, grid().querySelectorAll(".cut-tab").length])
    .toEqual(["cut-grid", "repeat(auto-fill, minmax(180px, 1fr))", "BUTTON", 2]);

  // 리스트 한 번 — 줄. 번호는 이름의 숫자 그대로(0010), 번호 칸은 네 자리에 맞춘다
  view = { layout: "list", table: false };
  draw();
  expect([grid().className, grid().style.gridTemplateColumns, grid().style.getPropertyValue("--ep-num-w"), row("C0010").className])
    .toEqual(["cut-grid ep-board ep-list", "minmax(0, 1fr)", "74px", "cut-card ep-card ep-list leaf"]);
  const text = (el: Element, selector: string) => el.querySelector(selector)?.textContent ?? null;
  expect([text(row("C0010"), ".ep-num"), text(row("C0010"), ".ep-name"), text(row("C0010"), ".ep-pchip"), text(row("C0010"), ".ep-line"), text(row("C0010"), ".ep-enter")])
    .toEqual(["0010", "C0010", "★ 대표", "14건 · 영상 13", "폴더로 ▸"]);
  expect([...row("C0010").querySelectorAll(".ep-rv > span")].map((one) => `${one.className}|${one.textContent}`)).toEqual(["|공유 11", "fin|★ 최종 2", "held|R 1"]);
  // 생성물 띠 — 열 개가 다 못 실리면(14건) 아홉 장 + '+5'. 대표는 테두리, 최종·보류는 표시, 만든 사람은 이름
  const tiles = () => [...row("C0010").querySelectorAll<HTMLButtonElement>(".ep-strip.takes > .ep-take")];
  expect([tiles().length, text(row("C0010"), ".ep-cut.more"), tiles()[0].className, text(tiles()[1], ".ep-take-m.fin"), text(tiles()[2], ".ep-take-m.held"), text(tiles()[0], ".ep-take-by"), tiles()[2].querySelector(".ep-take-by")])
    .toEqual([9, "+5", "ep-cut ep-take rep", "★", "R", "리버", null]);
  // 옛 서버의 컷 — 번호·표지·이름·건수·단추만(띠·검토·대표 표시 중 서버 값이 필요한 것은 빠진다)
  expect([text(row("C0020"), ".ep-line"), row("C0020").querySelector(".ep-rv"), row("C0020").querySelector(".ep-strip"), text(row("C0020"), ".ep-pchip"), text(row("C0020"), ".ep-enter")])
    .toEqual(["2건", null, null, "대표 미정", "폴더로 ▸"]);
  // 띠의 그림 = 크게 보기(띠에 실린 것끼리 넘겨 본다) — 카드를 고르거나 모아보기를 열지 않는다
  mouse("mousedown", tiles()[3]);
  mouse("mouseup", window);
  act(() => tiles()[3].click());
  expect([selected.size, reels.length, previews.length, previews[0].url, previews[0].index, previews[0].items!.map((item) => item.genId).join()])
    .toEqual([0, 0, 1, "/m/t3.mp4", 3, "t0,t1,t2,t3,t4,t6,t7,t8"]);
  // 크게 보기를 닫으면 초점이 그 띠 단추로 돌아온다 — 거기서 Enter·Space 는 그 단추의 키지만 방향키·Ctrl+A 는 격자의 것이다(Codex 코드 리뷰:
  //  전엔 단추에 초점이 있으면 격자의 키가 모두 죽었다). 출발 자리는 그 단추가 든 줄
  const key = (init: KeyboardEventInit) => act(() => { tiles()[3].dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })); });
  tiles()[3].focus();
  key({ key: "Enter" });
  expect([selected.size, reels.length]).toEqual([0, 0]);
  key({ key: "ArrowRight" });
  expect([...selected]).toEqual(["e035/C0020"]);
  tiles()[3].focus();
  key({ key: "a", ctrlKey: true });
  expect(selected.size).toBe(2);
  // [폴더로]·'+N' = 그 컷 폴더로. 줄 자체는 컷 카드와 같다 — 한 번 클릭 = 고르기, 두 번 클릭 = 모아보기
  act(() => row("C0010").querySelector<HTMLButtonElement>(".ep-enter")!.click());
  act(() => row("C0010").querySelector<HTMLButtonElement>(".ep-cut.more")!.click());
  expect(entered).toEqual(["e035/C0010", "e035/C0010"]);
  mouse("mousedown", row("C0010").querySelector(".ep-name")!);
  mouse("mouseup", window);
  dbl(row("C0010").querySelector(".ep-name")!);
  expect([[...selected], reels, entered.length]).toEqual([["e035/C0010"], [["e035/C0010"]], 2]);

  // 리스트 한 번 더 — 표. 머리줄은 카드가 아니고(고르기·키의 대상이 아님), 줄은 같은 .cut-card[data-path]
  view = { layout: "list", table: true };
  draw();
  expect([grid().className, grid().style.gridTemplateColumns, row("C0010").className]).toEqual(["cut-grid ep-board ep-table", "minmax(0, 1fr)", "cut-card ep-card ep-table leaf sel"]);
  const cells = (el: Element) => [...el.children].map((one) => one.textContent);
  expect(cells(host.querySelector(".ep-table-head")!)).toEqual(["", "", "컷", "대표", "건수", "영상", "공유", "★ 최종", "R 보류", "마지막 공유", "작업자", ""]);
  expect(host.querySelector(".ep-table-head")!.matches(".cut-card, [data-path]")).toBe(false);
  expect(cells(row("C0010"))).toEqual(["0010", "", "C0010", "★ 대표", "14", "13", "11", "2", "1", "-", "리버 12 · 팀원 2", "폴더로 ▸"]);
  expect(cells(row("C0020"))).toEqual(["0020", "", "C0020", "미정", "2", "-", "-", "-", "-", "-", "-", "폴더로 ▸"]); // 옛 서버 — 모르는 칸은 '-'
  act(() => row("C0020").querySelector<HTMLButtonElement>(".ep-enter")!.click());
  expect(entered[2]).toBe("e035/C0020");
});

it("에피소드 화면의 표 — '컷' 열이 생기고 대표는 정한 컷 수, 단추는 [열기]", () => {
  const episode: FolderCard = { ...card("e035", 201), path: "e035", name: "e035", subfolders: 31, rep_count: 1, video_count: 40, final_count: 5, held_count: 9, children: [], takes: [], workers: [] };
  act(() => root.render(<FolderCardGrid {...gridProps} layout="list" table top folders={[episode]} outside={0} />));
  expect(host.querySelector(".cut-grid")!.className).toBe("cut-grid ep-board ep-table has-cuts");
  const cells = (el: Element) => [...el.children].map((one) => one.textContent);
  expect(cells(host.querySelector(".ep-table-head")!)).toEqual(["", "", "에피소드", "컷", "대표", "건수", "영상", "공유", "★ 최종", "R 보류", "마지막 공유", "작업자", ""]);
  expect(cells(host.querySelector(".cut-card[data-path]")!)).toEqual(["035", "", "e035", "31", "★ 1/31", "201", "40", "187", "5", "9", "-", "-", "열기 ▸"]);
});
// jsdom 은 자리를 안 재 준다 — 카드마다 가짜 네모(가로로 한 줄, 200px 간격)
function placeTiles() {
  [...host.querySelectorAll<HTMLElement>(".cut-card[data-path]")].forEach((tile, i) => {
    tile.getBoundingClientRect = () => ({ left: i * 200, right: i * 200 + 180, top: 0, bottom: 180, width: 180, height: 180, x: i * 200, y: 0, toJSON: () => ({}) });
  });
  host.querySelector<HTMLElement>(".cut-grid")!.getBoundingClientRect = () => ({ left: 0, right: 1000, top: 0, bottom: 400, width: 1000, height: 400, x: 0, y: 0, toJSON: () => ({}) });
}

it("한 번 클릭 = 그것만, Ctrl = 토글, Shift = 마지막으로 누른 것부터 범위. 빈 곳 클릭 = 비움", () => {
  const folders = [card("C0010", 1), card("C0020", 1), card("C0030", 1), card("C0040", 1)];
  let selected = new Set<string>();
  const draw = () => act(() => root.render(
    <FolderCardGrid {...gridProps} folders={folders} selected={selected} onSelect={(next) => { selected = next; draw(); }} outside={1} />,
  ));
  draw();
  const tile = (name: string) => host.querySelector<HTMLElement>(`.cut-card[data-path="e035/${name}"]`)!;
  const press = (name: string, init: MouseEventInit = {}) => { mouse("mousedown", tile(name), init); mouse("mouseup", window, init); };
  press("C0020");
  expect([...selected]).toEqual(["e035/C0020"]);
  expect(tile("C0020").classList.contains("sel")).toBe(true);
  expect(tile("C0020").getAttribute("aria-pressed")).toBe("true");
  press("C0040", { ctrlKey: true });
  expect([...selected].sort()).toEqual(["e035/C0020", "e035/C0040"]);
  press("C0020", { ctrlKey: true }); // 토글로 뺀다
  expect([...selected]).toEqual(["e035/C0040"]);
  press("C0010", { shiftKey: true }); // 마지막으로 누른 C0020 ~ C0010
  expect([...selected]).toEqual(["e035/C0010", "e035/C0020"]);
  press("C0030", { shiftKey: true }); // 시작은 그대로(C0020) — 범위를 고친다
  expect([...selected]).toEqual(["e035/C0020", "e035/C0030"]);
  mouse("mousedown", host.querySelector(".cut-out")!); // '컷 밖' 칸은 고르는 대상이 아니다
  mouse("mouseup", window);
  expect([...selected]).toEqual(["e035/C0020", "e035/C0030"]);
  mouse("mousedown", host.querySelector(".cut-grid")!); // 빈 곳
  mouse("mouseup", window);
  expect(selected.size).toBe(0);
});

// 2026-10-12 조작 점검 18회차(Codex 전수 검토, 조작 규칙 45): 기준 카드가 그사이 목록에서 사라지면(다른 창이 그 폴더를 지우거나 이름을 바꿨다)
//  '고른 것 중 마지막 카드'를 대신 쓰는데, 그 대신 잡은 기준을 기억하지 않았다 — 다음 Shift 클릭이 또 '고른 것 중 마지막'에서 재서 범위가 잘렸다.
it.each(["클릭", "방향키"] as const)("Shift 의 기준 카드가 목록에서 사라지면 대신 잡은 기준을 기억한다 — 이어지는 Shift %s 가 범위를 잃지 않는다", (way) => {
  let folders = [card("C0010", 1), card("C0020", 1), card("C0030", 1), card("C0040", 1), card("C0050", 1)];
  let selected = new Set<string>();
  const draw = () => act(() => root.render(
    <FolderCardGrid {...gridProps} folders={folders} selected={selected} onSelect={(next) => { selected = next; draw(); }} />,
  ));
  draw();
  const tile = (name: string) => host.querySelector<HTMLElement>(`.cut-card[data-path="e035/${name}"]`)!;
  const press = (name: string, init: MouseEventInit = {}) => { mouse("mousedown", tile(name), init); mouse("mouseup", window, init); };
  const extendTo = (name: string) => {
    if (way === "클릭") press(name, { shiftKey: true });
    else act(() => { host.querySelector(".cut-grid")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", shiftKey: true, bubbles: true, cancelable: true })); });
  };
  press("C0010");
  press("C0020", { shiftKey: true });
  expect([...selected]).toEqual(["e035/C0010", "e035/C0020"]);
  folders = folders.slice(1); // 기준(C0010)이 목록에서 빠졌다
  selected = new Set(["e035/C0020"]);
  draw();
  extendTo("C0030");
  expect([...selected]).toEqual(["e035/C0020", "e035/C0030"]); // 방향키는 전엔 여기서 C0030 한 장만 남았다
  extendTo("C0040");
  expect([...selected]).toEqual(["e035/C0020", "e035/C0030", "e035/C0040"]); // 클릭은 전엔 C0030·C0040 — C0020 이 빠졌다
});

// Codex 코드 리뷰: 마지막으로 누른 카드(기준이자 방향키의 출발 자리)가 사라졌는데 '고른 것'에는 남아 있을 수 있다 — 부모는 고른 것을
//  목록과의 교집합으로 쓰기 때문에 목록이 새로 와도 지우지 않는다. 그 자리를 그대로 가리키면 방향키가 맨 앞 카드로 튀었다.
it("방향키의 출발 자리가 목록에서 사라졌으면 고른 것 중 남아 있는 마지막 카드에서 출발한다 — 맨 앞 카드로 튀지 않는다", () => {
  let folders = ["C0010", "C0020", "C0030", "C0040", "C0050"].map((name) => card(name, 1));
  let selected = new Set<string>();
  const draw = () => act(() => root.render(
    <FolderCardGrid {...gridProps} folders={folders} selected={selected} onSelect={(next) => { selected = next; draw(); }} />,
  ));
  draw();
  const tile = (name: string) => host.querySelector<HTMLElement>(`.cut-card[data-path="e035/${name}"]`)!;
  const press = (name: string, init: MouseEventInit = {}) => { mouse("mousedown", tile(name), init); mouse("mouseup", window, init); };
  press("C0030");
  press("C0050", { ctrlKey: true }); // 마지막으로 누른 카드 = C0050
  folders = folders.slice(0, 4); // 다른 창이 C0050 을 지웠다 — 고른 것(selected)에는 그대로 남아 있다
  draw();
  act(() => { host.querySelector(".cut-grid")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", shiftKey: true, bubbles: true, cancelable: true })); });
  expect([...selected]).toEqual(["e035/C0020", "e035/C0030"]); // 전엔 맨 앞의 C0010 한 장
});
it("빈 곳에서 끌면 걸친 카드를 모두 고른다 — 창을 떠나면(blur) 버린다. 휠 클릭 = 그 카드를 고르고 컷 정보", () => {
  const folders = [card("C0010", 1), card("C0020", 1), card("C0030", 1)];
  let selected = new Set<string>();
  const info: [string, number, number][] = [];
  const draw = () => act(() => root.render(
    <FolderCardGrid
      {...gridProps} folders={folders} selected={selected} onSelect={(next) => { selected = next; draw(); }}
      onInfo={(folder, x, y) => info.push([folder.path, x, y])} outside={0}
    />,
  ));
  draw();
  placeTiles();
  const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => { cb(0); return 1; });
  try {
    const grid = host.querySelector(".cut-grid")!;
    mouse("mousedown", grid, { clientX: 950, clientY: 300 });
    mouse("mousemove", window, { clientX: 370, clientY: 100 }); // C0020(200~380)·C0030(400~580)에 걸친다, C0010(0~180)은 아니다
    expect(host.querySelector(".assets-marquee")).not.toBeNull();
    expect([...selected].sort()).toEqual(["e035/C0020", "e035/C0030"]);
    mouse("mouseup", window, { clientX: 370, clientY: 100 });
    expect(host.querySelector(".assets-marquee")).toBeNull();
    expect([...selected].sort()).toEqual(["e035/C0020", "e035/C0030"]);
    // Ctrl 로 끌면 더한다
    mouse("mousedown", grid, { clientX: 190, clientY: 300, ctrlKey: true });
    mouse("mousemove", window, { clientX: 10, clientY: 10, ctrlKey: true });
    mouse("mouseup", window, { clientX: 10, clientY: 10, ctrlKey: true });
    expect([...selected].sort()).toEqual(["e035/C0010", "e035/C0020", "e035/C0030"]);
    // 카드 위에서 시작한 끌기도 마퀴다(꽉 찬 격자에는 빈 곳이 없다) — C0010 에서 C0020 까지 끌면 둘
    mouse("mousedown", host.querySelector('.cut-card[data-path="e035/C0010"]')!, { clientX: 100, clientY: 100 });
    mouse("mousemove", window, { clientX: 300, clientY: 100 });
    expect(host.querySelector(".assets-marquee")).not.toBeNull();
    mouse("mouseup", window, { clientX: 300, clientY: 100 });
    expect([...selected].sort()).toEqual(["e035/C0010", "e035/C0020"]);
    mouse("mousedown", host.querySelector('.cut-card[data-path="e035/C0010"]')!, { clientX: 100, clientY: 100 });
    mouse("mousemove", window, { clientX: 590, clientY: 100, ctrlKey: true });
    mouse("mouseup", window, { clientX: 590, clientY: 100, ctrlKey: true });
    expect(selected.size).toBe(3);
    // 창을 떠나면 끌기를 버린다 — 돌아온 뒤의 mouseup 이 클릭으로 이어지지 않는다
    mouse("mousedown", host.querySelector('.cut-card[data-path="e035/C0020"]')!, { clientX: 300, clientY: 100 });
    act(() => { window.dispatchEvent(new Event("blur")); });
    mouse("mouseup", window, { clientX: 300, clientY: 100 });
    expect(selected.size).toBe(3);
    // 마지막 움직임의 프레임이 돌기 전에 놓아도 그 계산은 버리지 않는다(Codex 코드 리뷰) — 창을 떠난 것은 버린다
    raf.mockImplementation(() => 7);
    mouse("mousedown", grid, { clientX: 950, clientY: 300 });
    mouse("mousemove", window, { clientX: 370, clientY: 100 });
    expect(selected.size).toBe(3); // 아직 안 돌았다
    mouse("mouseup", window, { clientX: 370, clientY: 100 });
    expect([...selected].sort()).toEqual(["e035/C0020", "e035/C0030"]);
    mouse("mousedown", grid, { clientX: 950, clientY: 300 });
    mouse("mousemove", window, { clientX: 10, clientY: 10 });
    act(() => { window.dispatchEvent(new Event("blur")); });
    expect([...selected].sort()).toEqual(["e035/C0020", "e035/C0030"]);
    // 단추를 뗀 채 온 움직임(mouseup 을 놓쳤다)도 끌기의 끝이다 — 그 뒤의 움직임이 선택을 바꾸지 않고(2026-10-11 실측: 걸음마다 바뀌었다),
    //  카드를 누른 채 놓친 것은 클릭이 되지 않는다
    raf.mockImplementation((cb) => { cb(0); return 1; });
    mouse("mousedown", grid, { clientX: 950, clientY: 300 });
    mouse("mousemove", window, { clientX: 370, clientY: 100 });
    mouse("mousemove", window, { clientX: 10, clientY: 10, buttons: 0 });
    mouse("mousemove", window, { clientX: 590, clientY: 10, buttons: 0 });
    expect(host.querySelector(".assets-marquee")).toBeNull();
    expect([...selected].sort()).toEqual(["e035/C0020", "e035/C0030"]);
    mouse("mousedown", host.querySelector('.cut-card[data-path="e035/C0010"]')!, { clientX: 100, clientY: 100 });
    mouse("mousemove", window, { clientX: 101, clientY: 100, buttons: 0 });
    mouse("mouseup", window, { clientX: 101, clientY: 100 });
    expect([...selected].sort()).toEqual(["e035/C0020", "e035/C0030"]);
    // 카드를 누른 뒤 마퀴로 다른 카드를 고르면 Shift 클릭의 시작은 고른 것 중 마지막 카드다(생성물 격자와 같다) — 전엔 먼저 누른 카드부터였고,
    //  누른 카드가 없으면 한 장만 골랐다
    raf.mockImplementation((cb) => { cb(0); return 1; });
    const tileOf = (name: string) => host.querySelector(`.cut-card[data-path="e035/${name}"]`)!;
    mouse("mousedown", tileOf("C0010"), { clientX: 100, clientY: 100 }); mouse("mouseup", window, { clientX: 100, clientY: 100 });
    expect([...selected]).toEqual(["e035/C0010"]);
    mouse("mousedown", grid, { clientX: 950, clientY: 300 });
    mouse("mousemove", window, { clientX: 370, clientY: 100 });
    mouse("mouseup", window, { clientX: 370, clientY: 100 });
    expect([...selected].sort()).toEqual(["e035/C0020", "e035/C0030"]);
    mouse("mousedown", tileOf("C0020"), { clientX: 300, clientY: 100, shiftKey: true });
    mouse("mouseup", window, { clientX: 300, clientY: 100, shiftKey: true });
    expect([...selected].sort()).toEqual(["e035/C0020", "e035/C0030"]);
    // 이어지는 Shift 클릭은 같은 카드에서 잰다(기준이 '고른 것 중 마지막'으로 옮겨 가지 않는다)
    const marqueeFirst = () => {
      mouse("mousedown", grid, { clientX: 190, clientY: 300 });
      mouse("mousemove", window, { clientX: 10, clientY: 10 });
      mouse("mouseup", window, { clientX: 10, clientY: 10 });
      expect([...selected]).toEqual(["e035/C0010"]);
    };
    const shiftClick = (name: string, x: number) => {
      mouse("mousedown", tileOf(name), { clientX: x, clientY: 100, shiftKey: true });
      mouse("mouseup", window, { clientX: x, clientY: 100, shiftKey: true });
    };
    marqueeFirst();
    shiftClick("C0030", 500);
    expect(selected.size).toBe(3);
    shiftClick("C0020", 300);
    expect([...selected].sort()).toEqual(["e035/C0010", "e035/C0020"]);
    // 마퀴 뒤 Shift+방향키도 범위다(전엔 한 장만 골랐다)
    marqueeFirst();
    act(() => { grid.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", shiftKey: true, bubbles: true, cancelable: true })); });
    expect([...selected].sort()).toEqual(["e035/C0010", "e035/C0020"]);
  } finally {
    raf.mockRestore();
  }
  // 휠 클릭 — 안 고른 카드면 그것만 고르고 정보를 연다
  selected = new Set(["e035/C0010"]);
  draw();
  act(() => { host.querySelector('.cut-card[data-path="e035/C0030"]')!.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, button: 1, clientX: 450, clientY: 90 })); });
  expect([...selected]).toEqual(["e035/C0030"]);
  expect(info).toEqual([["e035/C0030", 450, 90]]);
  act(() => { host.querySelector('.cut-card[data-path="e035/C0030"]')!.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, button: 1, clientX: 1, clientY: 2 })); });
  expect([...selected]).toEqual(["e035/C0030"]); // 이미 고른 카드면 선택은 그대로
  expect(info).toHaveLength(2);
});

// 2026-10-13 낮(Jay): 컷 카드 두 번 클릭 = 모아보기(고른 카드 위면 고른 컷 전부(격자 순서), 아니면 그 컷만 골라서 — 29회차엔 우클릭이 이것이었다),
//  우클릭 = 그 폴더의 창(고르지 않은 카드면 그것만 골라서). 위에 뜬 메뉴를 닫는 우클릭(누름 시작에 가려져 있었다)은 열지 않는다 — contextmenu 는
//  단추를 뗀 뒤 오므로 가림을 누름 시작에 적어 둔다.
it("두 번 클릭 = 모아보기(고른 컷 전부·격자 순서) · 우클릭 = 그 폴더의 창. 메뉴를 닫는 우클릭은 열지 않고, 메뉴 키는 그 순간의 가림을 본다", async () => {
  const folders = [card("C0010", 1), card("C0020", 1), card("C0030", 1)];
  let selected = new Set<string>(["e035/C0030", "e035/C0010"]);
  const reels: string[][] = [];
  const opened: string[] = [];
  const draw = () => act(() => root.render(
    <FolderCardGrid
      {...gridProps} folders={folders} selected={selected} onSelect={(next) => { selected = next; draw(); }}
      onReel={(paths) => reels.push(paths)} onOpen={(folder) => opened.push(folder.path)} outside={0}
    />,
  ));
  draw();
  const tile = (name: string) => host.querySelector<HTMLElement>(`.cut-card[data-path="e035/${name}"]`)!;
  // 두 번 클릭 — 고른 카드 위면 고른 컷 전부(격자 순서, 고르기는 그대로), 고르지 않은 카드면 그것만 골라서. 창은 열지 않는다
  dbl(tile("C0010"));
  expect([reels, [...selected].sort()]).toEqual([[["e035/C0010", "e035/C0030"]], ["e035/C0010", "e035/C0030"]]);
  dbl(tile("C0020"));
  expect([reels[1], [...selected], opened]).toEqual([["e035/C0020"], ["e035/C0020"], []]);
  // 실제 누름 순서 — 일반 두 번 클릭의 첫 클릭이 고르기를 그 카드 하나로 줄이므로 결국 그 컷만(탐색기와 같다). Ctrl 로 고른 뒤 두 번 클릭하면 전부(Codex 코드 리뷰)
  selected = new Set(["e035/C0030", "e035/C0010"]); draw();
  mouse("mousedown", tile("C0010")); mouse("mouseup", window);
  dbl(tile("C0010"));
  expect([reels[2], [...selected]]).toEqual([["e035/C0010"], ["e035/C0010"]]);
  mouse("mousedown", tile("C0030"), { ctrlKey: true }); mouse("mouseup", window, { ctrlKey: true });
  dbl(tile("C0030"));
  expect([reels[3], [...selected].sort()]).toEqual([["e035/C0010", "e035/C0030"], ["e035/C0010", "e035/C0030"]]);
  selected = new Set(["e035/C0030", "e035/C0010"]); draw();
  // jsdom 에는 PointerEvent 가 없다 — lib/keyGate 가 보는 것은 이벤트 이름뿐이라 Event 로 보낸다(round7Grid 의 press 와 같다)
  const rightClick = (el: HTMLElement) => {
    act(() => { el.dispatchEvent(new Event("pointerdown", { bubbles: true })); });
    mouse("mousedown", el, { button: 2, buttons: 2 });
    act(() => { el.dispatchEvent(new Event("pointerup", { bubbles: true })); });
    mouse("mouseup", el, { button: 2 });
    const menu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
    act(() => { el.dispatchEvent(menu); });
    return menu.defaultPrevented;
  };
  // 고른 카드 위 — 그 폴더의 창. 고르기는 그대로, 모아보기는 열지 않는다
  expect(rightClick(tile("C0010"))).toBe(true); // 브라우저 메뉴는 막는다
  expect([opened, reels.length]).toEqual([["e035/C0010"], 4]);
  expect([...selected].sort()).toEqual(["e035/C0010", "e035/C0030"]);
  // 고르지 않은 카드 — 그것만 골라서 연다
  rightClick(tile("C0020"));
  expect(opened).toEqual(["e035/C0010", "e035/C0020"]);
  expect([...selected]).toEqual(["e035/C0020"]);
  // 위에 메뉴가 떠 있는 채 시작한 우클릭(메뉴를 닫는 누름) — 메뉴는 누름의 앞쪽(pointerdown)에 닫혀 contextmenu 때는 이미 없다. 열지 않는다
  const { useKeyOwner } = await import("../src/lib/keyGate");
  function Owner({ on }: { on: boolean }) { useKeyOwner(on); return null; }
  const owner = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => owner.render(<Owner on />));
  act(() => { tile("C0030").dispatchEvent(new Event("pointerdown", { bubbles: true })); });
  act(() => owner.render(<Owner on={false} />)); // 메뉴가 닫혔다
  mouse("mousedown", tile("C0030"), { button: 2, buttons: 2 });
  act(() => { tile("C0030").dispatchEvent(new Event("pointerup", { bubbles: true })); });
  act(() => { tile("C0030").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 })); });
  expect(opened).toHaveLength(2);
  expect([...selected]).toEqual(["e035/C0020"]);
  // 키보드의 메뉴 키(누름 없이 contextmenu 만) — 위에 창이 떠 있으면 쉬고, 없으면 연다
  act(() => owner.render(<Owner on />));
  act(() => { tile("C0020").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); });
  expect(opened).toHaveLength(2);
  act(() => owner.render(<Owner on={false} />));
  act(() => { tile("C0020").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); });
  expect(opened).toHaveLength(3);
  expect(opened[2]).toBe("e035/C0020");
  // 격자의 빈 곳에서 메뉴를 닫는 우클릭(가려진 채 시작) → 그 기록이 남아 다음 메뉴 키를 삼키면 안 된다(Codex 코드 리뷰)
  const grid = host.querySelector<HTMLElement>(".cut-grid")!;
  act(() => owner.render(<Owner on />));
  act(() => { grid.dispatchEvent(new Event("pointerdown", { bubbles: true })); });
  act(() => owner.render(<Owner on={false} />));
  mouse("mousedown", grid, { button: 2, buttons: 2 });
  act(() => { grid.dispatchEvent(new Event("pointerup", { bubbles: true })); });
  act(() => { grid.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 })); });
  expect(opened).toHaveLength(3); // 빈 곳 — 아무것도 안 연다
  act(() => { tile("C0020").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); }); // 메뉴 키 — 가림 없음
  expect(opened).toHaveLength(4);
  // 카드 위에서 우클릭을 시작해 카드 밖(격자 빈 곳)에서 떼어도 기록은 지워진다 — 다음 메뉴 키가 삼켜지지 않는다
  act(() => owner.render(<Owner on />));
  act(() => { tile("C0020").dispatchEvent(new Event("pointerdown", { bubbles: true })); });
  act(() => owner.render(<Owner on={false} />));
  mouse("mousedown", tile("C0020"), { button: 2, buttons: 2 });
  act(() => { grid.dispatchEvent(new Event("pointerup", { bubbles: true })); });
  act(() => { grid.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 })); });
  expect(opened).toHaveLength(4);
  act(() => { tile("C0020").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); });
  expect([opened.length, reels.length]).toEqual([5, 4]); // 우클릭은 끝까지 모아보기를 열지 않았다
  act(() => owner.unmount());
});

it("키보드 — Ctrl+A 모두 · 방향키 옮기기(Shift = 누른 카드부터 범위) · Enter = 두 번 클릭 · Space = 토글. 초점이 없어도(BODY) 먹고, 위에 창이 떠 있으면 쉰다", async () => {
  const { useEscapeClose } = await import("../src/lib/useEscapeClose");
  function Overlay() { useEscapeClose(() => {}); return null; }
  const folders = [card("C0010", 1), { ...card("E01", 1), subfolders: 2 }, card("C0030", 1), card("C0040", 1)];
  let selected = new Set<string>();
  let overlay = false;
  const entered: string[] = [];
  const reels: string[][] = [];
  const draw = () => act(() => root.render(<>
    {overlay ? <Overlay /> : null}
    <FolderCardGrid {...gridProps} folders={folders} selected={selected} onSelect={(next) => { selected = next; draw(); }}
      onEnter={(folder) => entered.push(folder.name)} onReel={(paths) => reels.push(paths)} outside={1} />
  </>));
  draw();
  const grid = host.querySelector<HTMLElement>(".cut-grid")!;
  const tile = (name: string) => host.querySelector<HTMLElement>(`.cut-card[data-path="e035/${name}"]`)!;
  const key = (name: string, init: KeyboardEventInit = {}, target: EventTarget = grid) => {
    const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init });
    act(() => { target.dispatchEvent(event); });
    return event;
  };
  expect(key("a", { ctrlKey: true }).defaultPrevented).toBe(true); // 화면 글자를 긁지 않는다
  expect(selected.size).toBe(4);

  mouse("mousedown", tile("C0010")); mouse("mouseup", window); // 누른 카드에서 시작
  key("ArrowRight");
  expect([...selected]).toEqual(["e035/E01"]);
  key("Enter"); // 하위 폴더가 있으면 들어가기
  expect(entered).toEqual(["E01"]);
  key("ArrowRight", { shiftKey: true }); // 방금 옮긴 카드(E01)부터 범위
  expect([...selected]).toEqual(["e035/E01", "e035/C0030"]);
  key("ArrowRight");
  expect([...selected]).toEqual(["e035/C0040"]);
  key("Enter"); // 하위 폴더가 없으면(컷) 모아보기 — 아침엔 들어가기, 그 전엔 창(Jay 2026-10-13)
  expect([entered, reels]).toEqual([["E01"], [["e035/C0040"]]]);
  key(" ");
  expect(selected.size).toBe(0);
  // 길게 눌린 Space(반복 keydown)는 막기만 한다 — 고르기가 반복마다 뒤집히지 않는다(조작 규칙 38)
  expect([key(" ", { repeat: true }).defaultPrevented, selected.size]).toEqual([true, 0]);
  key("Enter"); // Space 로 뺀 자리는 화면에 표시가 없다 — Enter 가 아무것도 열지 않는다
  expect([entered, reels.length]).toEqual([["E01"], 1]);
  key("ArrowRight"); // 끝에서는 멈춘다
  expect([...selected]).toEqual(["e035/C0040"]);

  act(() => { (document.activeElement as HTMLElement | null)?.blur?.(); }); // 초점이 어디에도 없을 때
  key("ArrowLeft", {}, document.body);
  expect([...selected]).toEqual(["e035/C0030"]);
  expect(document.activeElement).toBe(grid);

  key("Enter", {}, host.querySelector(".cut-out")!); // '컷 밖' 칸의 Enter 는 그 단추를 누르는 키
  expect([entered, reels.length]).toEqual([["E01"], 1]);

  overlay = true; draw(); // 위에 창이 떠 있으면 키는 그 창의 것 — 그것을 닫는 누름도 고른 것을 바꾸지 않는다
  key("ArrowLeft");
  key("a", { ctrlKey: true });
  mouse("mousedown", tile("C0010")); mouse("mouseup", window);
  expect([...selected]).toEqual(["e035/C0030"]);
  overlay = false; draw();

  // 마퀴로 고른 뒤(남긴 자리가 고른 것에 없다) 방향키는 고른 것 중 마지막 카드에서 간다
  selected = new Set(["e035/C0010", "e035/E01"]); draw();
  key("ArrowRight");
  expect([...selected]).toEqual(["e035/C0030"]);
  // 밖에서 선택을 비우면(Esc) 가리키는 카드도 없다 — 보이지 않는 자리에 Enter 가 듣지 않는다
  selected = new Set(); draw();
  const enteredBefore = [...entered];
  key("Enter");
  expect(entered).toEqual(enteredBefore);
  // Tab 으로 초점을 옮긴 카드가 있으면 Enter 는 그 카드의 것, 길게 눌린 Enter 는 무시
  act(() => tile("E01").focus());
  key("Enter", { repeat: true }, tile("E01"));
  expect(entered).toEqual(enteredBefore);
  key("Enter", {}, tile("E01"));
  expect(entered).toEqual([...enteredBefore, "E01"]);
  // 초점이 카드에 놓인 채 방향키를 누르면 초점은 격자로 온다 — 남으면 다음 방향키가 다시 그 카드에서 출발해 한 칸에서 멈춘다
  act(() => tile("E01").focus());
  key("ArrowRight", {}, tile("E01"));
  expect(document.activeElement).toBe(grid);
  key("ArrowRight");
  expect([...selected]).toEqual(["e035/C0040"]);
  expect(key("ArrowLeft", { altKey: true }).defaultPrevented).toBe(false); // Alt+← 는 브라우저의 뒤로
});
