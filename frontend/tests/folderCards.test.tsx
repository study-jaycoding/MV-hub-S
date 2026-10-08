// @vitest-environment jsdom
// 공유 & 리뷰 탭의 폴더 묶음 보기 — 묶어 보일 수 있는 조회의 규칙, 폴더 카드 받기(문맥·순번·옛 서버), 컷 카드 격자.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FolderCard, FolderCards, GenQuery, Generation } from "../src/types";

const folderCardsApi = vi.hoisted(() => vi.fn());
vi.mock("../src/api", () => ({ api: { folderCards: folderCardsApi, thumbOrRaw: (path: string) => path } }));

import { FolderCardGrid } from "../src/components/FolderCardGrid";
import { folderCardsScope, parentFolder, singleTeamWorkspace, type FolderCardsScope } from "../src/lib/folderCards";
import { HttpError } from "../src/lib/http";
import { useFolderCards } from "../src/lib/useFolderCards";

const base: GenQuery = { tab: "team", project_id: "p1", folder_path: "e035", colors: [], tags: [], auto_tags: [] };
const cover = (id: string, type: "image" | "video" = "image") => ({
  id, project_id: "p1", project_name: "뻘뻘뻘", folder_path: "e035/C0010",
  assets: [{ type, file_path: `/media/${id}.png`, thumbnail_path: `/media/${id}.png` }],
}) as unknown as Generation;
const card = (name: string, count: number, rep = false, type: "image" | "video" = "image"): FolderCard => ({
  path: `e035/${name}`, name, count, rep, cover: cover(`cover-${name}`, type),
});
const cards = (...folders: FolderCard[]): FolderCards => ({ parent: "e035", own_count: 0, folders });

it("묶어 보일 수 있는 조회 — 공유 탭에서 프로젝트의 폴더를 골랐고 무엇도 찾고 있지 않을 때만", () => {
  expect(folderCardsScope(base, false)).toEqual({ projectId: "p1", parent: "e035" });
  // 팀 공간 하나로 거르는 것까지는 서버가 같은 식으로 센다
  expect(folderCardsScope({ ...base, workspace_ids: ["ws-1"] }, false)).toEqual({ projectId: "p1", parent: "e035", workspaceId: "ws-1" });

  const flat: Partial<GenQuery>[] = [
    { tab: "my" }, { project_id: undefined }, { project_id: "none" }, { folder_path: undefined },
    { search: "cat" }, { creator_uid: "u" }, { worker_id: "w" }, { share_dir: "mine" }, { local_only: true },
    { include_deleted: true }, { deleted_only: true }, { color: "r" }, { tag: "x" },
    { media_type: "video" }, { review_filter: "held" }, { shared_only: true }, { comment_only: true }, { final_only: true },
    { colors: ["r"] }, { tags: ["x"] }, { auto_tags: ["y"] },
    { workspace_ids: ["ws-1", "ws-2"] }, { workspace_scope: "personal" },
  ];
  for (const change of flat) expect([change, folderCardsScope({ ...base, ...change }, false)]).toEqual([change, null]);
  expect(folderCardsScope(base, true)).toBeNull(); // 회색 숨김은 이 PC 에만 있는 조건이라 서버가 못 센다
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

it("reload 는 서버 값을 다시 읽고 끝난 뒤에 풀린다 — 그 앞에 출발한 응답이 늦게 와도 덮지 못한다", async () => {
  const early = hold();
  show({ scope: e035 }); // 저장 전에 출발한 조회
  folderCardsApi.mockResolvedValueOnce(cards(card("C0010", 8, true)));
  let done = false;
  await act(async () => { await seen.reload().then(() => { done = true; }); });
  expect(done).toBe(true);
  expect(seen.cards?.folders[0].rep).toBe(true);
  await early.release(cards(card("C0010", 8, false))); // 저장 전 값
  expect(seen.cards?.folders[0].rep).toBe(true);

  folderCardsApi.mockRejectedValueOnce(new Error("network"));
  await act(async () => { await seen.reload(); }); // 실패해도 던지지 않는다(잠금을 푸는 쪽이 기다린다)
  expect(seen.cards?.folders[0].rep).toBe(true);
});

it("저장 뒤의 재조회가 더 나중 조회로 대체되면 그 조회가 끝날 때 같이 풀린다 — 버려진 응답이 돌아온 순간에 풀지 않는다", async () => {
  folderCardsApi.mockResolvedValue(cards(card("C0010", 8)));
  show({ scope: e035 });
  await settle();
  const mine = hold(); // 저장 뒤의 재조회
  let done = false;
  let waiting!: Promise<void>;
  act(() => { waiting = seen.reload().then(() => { done = true; }); });
  const later = hold(); // 목록이 새로 들어와(reloadKey) 더 나중 조회가 출발 — 앞의 것을 대신한다
  show({ scope: e035, reloadKey: 1 });
  await mine.release(cards(card("C0010", 8, true))); // 버려지는 응답
  await settle();
  expect(done).toBe(false);
  expect(seen.cards?.folders[0].rep).toBe(false);
  await later.release(cards(card("C0010", 8, true)));
  await act(async () => { await waiting; });
  expect(done).toBe(true);
  expect(seen.cards?.folders[0].rep).toBe(true);
});

// ── 컷 카드 격자 ──
it("폴더마다 카드 한 장 — 이름·건수, 대표가 없으면 '대표 미정', 영상이면 재생 표시. 누르면 그 폴더를 연다", () => {
  const opened: string[] = [];
  const folders = [card("C0010", 8, true), card("C0040", 14, false, "video")];
  const showAll = vi.fn();
  const draw = (outside: number, shown: FolderCard[] = folders) => act(() => root.render(
    <FolderCardGrid folders={shown} scale={1} fill onOpen={(folder) => opened.push(folder.path)} outside={outside} onShowAll={showAll} />,
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
