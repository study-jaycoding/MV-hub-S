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
const gridProps = { scale: 1, fill: true, selected: new Set<string>(), onSelect: () => {}, onInfo: () => {}, onShowAll: () => {}, onOpen: () => {}, onEnter: () => {}, top: false };
const dbl = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });

it("폴더마다 카드 한 장 — 이름·건수, 대표가 없으면 '대표 미정', 영상이면 재생 표시. 두 번 누르면 그 폴더를 연다", () => {
  const opened: string[] = [];
  const folders = [card("C0010", 8, true), card("C0040", 14, false, "video")];
  const showAll = vi.fn();
  const draw = (outside: number, shown: FolderCard[] = folders) => act(() => root.render(
    <FolderCardGrid {...gridProps} folders={shown} onOpen={(folder) => opened.push(folder.path)} outside={outside} onShowAll={showAll} />,
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

it("하위 폴더가 있는 카드(에피소드)는 두 번 클릭에 들어가고, 없는 카드(컷)는 창을 연다. 맨 위에서는 '에피소드 밖'", () => {
  const entered: string[] = [];
  const opened: string[] = [];
  const episode: FolderCard = { ...card("e035", 14), path: "e035", subfolders: 5 };
  const leaf: FolderCard = { ...card("e036", 2), path: "e036", subfolders: 0 };
  const old: FolderCard = { ...card("e037", 1), path: "e037" }; // 옛 서버 — subfolders 없음 = 잎
  act(() => root.render(
    <FolderCardGrid {...gridProps} folders={[episode, leaf, old]} top onEnter={(f) => entered.push(f.path)} onOpen={(f) => opened.push(f.path)} outside={2} />,
  ));
  const tile = (path: string) => host.querySelector<HTMLElement>(`.cut-card[data-path="${path}"]`)!;
  expect(tile("e035").querySelector(".cut-tab")!.textContent).toBe("e035컷 5 ·14");
  expect(tile("e036").querySelector(".cut-tab")!.textContent).toBe("e0362");
  expect(tile("e035").title).toBe("e035 · 컷 5 · 14건");
  dbl(tile("e035"));
  dbl(tile("e036"));
  dbl(tile("e037"));
  expect(entered).toEqual(["e035"]);
  expect(opened).toEqual(["e036", "e037"]);
  expect(host.querySelector(".cut-out-count")!.textContent).toBe("에피소드 밖 2건");
});

// ── 고르기 — 한 번 클릭·Ctrl·Shift·빈 곳에서 끌기·휠 클릭 ──
const mouse = (type: string, el: EventTarget, init: MouseEventInit = {}) =>
  act(() => { el.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, ...init })); });
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

it("키보드 — Ctrl+A 모두 · 방향키 옮기기(Shift = 누른 카드부터 범위) · Enter = 두 번 클릭 · Space = 토글. 초점이 없어도(BODY) 먹고, 위에 창이 떠 있으면 쉰다", async () => {
  const { useEscapeClose } = await import("../src/lib/useEscapeClose");
  function Overlay() { useEscapeClose(() => {}); return null; }
  const folders = [card("C0010", 1), { ...card("E01", 1), subfolders: 2 }, card("C0030", 1), card("C0040", 1)];
  let selected = new Set<string>();
  let overlay = false;
  const opened: string[] = []; const entered: string[] = [];
  const draw = () => act(() => root.render(<>
    {overlay ? <Overlay /> : null}
    <FolderCardGrid {...gridProps} folders={folders} selected={selected} onSelect={(next) => { selected = next; draw(); }}
      onOpen={(folder) => opened.push(folder.name)} onEnter={(folder) => entered.push(folder.name)} outside={1} />
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
  key("Enter"); // 하위 폴더가 없으면 그 폴더의 창
  expect(opened).toEqual(["C0040"]);
  key(" ");
  expect(selected.size).toBe(0);
  key("ArrowRight"); // 끝에서는 멈춘다
  expect([...selected]).toEqual(["e035/C0040"]);

  act(() => { (document.activeElement as HTMLElement | null)?.blur?.(); }); // 초점이 어디에도 없을 때
  key("ArrowLeft", {}, document.body);
  expect([...selected]).toEqual(["e035/C0030"]);
  expect(document.activeElement).toBe(grid);

  key("Enter", {}, host.querySelector(".cut-out")!); // '컷 밖' 칸의 Enter 는 그 단추를 누르는 키
  expect(opened).toEqual(["C0040"]);

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
  const openedBefore = [...opened]; const enteredBefore = [...entered];
  key("Enter");
  expect(opened).toEqual(openedBefore);
  expect(entered).toEqual(enteredBefore);
  // Tab 으로 초점을 옮긴 카드가 있으면 Enter 는 그 카드의 것, 길게 눌린 Enter 는 무시
  act(() => tile("E01").focus());
  key("Enter", { repeat: true }, tile("E01"));
  expect(entered).toEqual(enteredBefore);
  key("Enter", {}, tile("E01"));
  expect(entered).toEqual([...enteredBefore, "E01"]);
  expect(key("ArrowLeft", { altKey: true }).defaultPrevented).toBe(false); // Alt+← 는 브라우저의 뒤로
});
