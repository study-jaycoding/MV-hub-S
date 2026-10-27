// @vitest-environment jsdom
// 편집 공유 — 화면에서: 알약(나만 보는 편집 · 서버에 저장 · 다른 편집 보기)·라임·응답 순서·오류 · V0 줄·메뉴·보기만 · V0 판·꼬리(재생 범위)·
//  따라가는 판이 끝 뒤에서 빔. 공유 서버 대신 api 의 세 요청을 가짜로 둔다(실사용 서버에 닿지 않는다).
//  설계 = docs/status/편집탭_편집공유_설계_2026-10-23.md · 계약 = docs/status/편집탭_편집공유_구현_2026-10-23.md.
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EditTree } from "../src/lib/useEditSequence";

const tree = vi.hoisted(() => ({ state: "ready", complete: true, note: null, roots: [
  { name: "e070", path: "e070", children: [{ name: "c1", path: "e070/c1" }, { name: "c2", path: "e070/c2" }] },
  { name: "e080", path: "e080", children: [{ name: "k9", path: "e080/k9" }, { name: "k10", path: "e080/k10" }] },
] }));
const team = vi.hoisted(() => ({ state: "ok", complete: true })); // 내 팀 목록 — 다 받았나 · 상한에서 멈췄나(V0 링크의 확인 중·확인 못 함)
vi.mock("../src/lib/useEditSequence", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/useEditSequence")>("../src/lib/useEditSequence");
  return {
    ...actual,
    useEditProjects: () => ({
      projects: [{ id: "p1", name: "P1" }], projectsState: "ok", tree: tree as EditTree, reload: () => {}, reloadCounts: () => {}, freshByProject: {},
    }),
    useEditGenerations: () => ({ state: team.state, gens: [], error: null, complete: team.complete, reload: () => {} }),
  };
});

import { api, type EditShareRow } from "../src/api";
import { EditTab } from "../src/components/timeline/EditTab";
import { getAccountNamespace } from "../src/lib/accountScope";
import { sha256Hex, TAIL_KEY, withTail, type ShareSnapshot } from "../src/lib/editShare";
import { buildLayout, emptyEditDoc, type EditLayout } from "../src/lib/editTimeline";
import { clearUndo, keepUnsavedEditDoc } from "../src/lib/editTimelineStore";
import { HttpError } from "../src/lib/http";
import { useEditFollow } from "../src/lib/useEditFollow";
import { useEditPlayback } from "../src/lib/useEditPlayback";
import type { NoticeLine } from "../src/lib/useStateNotices";

const DOC = "mvhub.editDoc:local:p1:e070";
const OTHER = "a".repeat(32);
let host: HTMLDivElement;
let root: Root;
let flash: ReturnType<typeof vi.fn>;
let rows: EditShareRow[];
const timecode = () => document.querySelector(".ed-tc")!.textContent;
const press = (init: KeyboardEventInit, target: EventTarget = document.body) => {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  act(() => { target.dispatchEvent(event); });
  return event;
};
const settle = () => act(async () => {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0));
});
const pill = () => document.querySelector<HTMLElement>(".ed-share-pill")!;
const menuItem = (label: string) => [...document.querySelectorAll<HTMLButtonElement>(".ed-share-item")].find((item) => item.querySelector("b")?.textContent === label)!;
const choose = async (label: string) => {
  act(() => document.querySelector<HTMLButtonElement>(".ed-share-caret")!.click());
  act(() => menuItem(label).click());
  await settle();
};
const focusWindow = async () => {
  act(() => { window.dispatchEvent(new Event("focus")); });
  await settle();
};
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, no) => { resolve = ok; reject = no; });
  return { promise, resolve, reject };
};
const savedHead = async (data: string, revision: number) => ({ revision, data_hash: await sha256Hex(data), updated_at: "2026-10-23T05:20:00.000Z" });
const snapshot = (total: number): string => JSON.stringify({
  v: 1, total, cuts: [
    { name: "c1", folder: "e070/c1", len: total / 2, parts: [{ len: total / 2, gen: "g1", kind: "video", head: 0 }] },
    { name: "c2", folder: "e070/c2", len: total / 2, parts: [{ len: total / 2, gap: true }] },
  ],
} satisfies ShareSnapshot);
let notices: readonly NoticeLine[] = []; // 편집 탭이 앱에 올린 경고 줄(화면 위 알림 줄 — 전엔 막대의 알약)
const mount = (authKey = "auth") => act(() => root.render(
  <EditTab authKey={authKey} authReady workspace={{ scope: "team", id: "w1", name: "W" }} keysActive flash={flash}
    onOpenCutFolder={() => {}} reloadSignal={0} peekPath={null} onPeekMarks={() => {}} onNotices={(lines) => { notices = lines; }}
    cardMenuRef={{ current: null }} onPreview={() => {}} onCompare={() => {}}
    resolve={{ send: () => {}, busy: false, pendingCount: 0 }} />,
));

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  localStorage.setItem("ch.editTimeline.last:local", JSON.stringify({ projectId: "p1", seq: "e070" }));
  localStorage.setItem(DOC, JSON.stringify({ v: 1, tracksOff: [], tracksLocked: [], clips: [
    { cut: "e070/c1", gen: "g1", track: 1, kind: "video", dur: 5 }, { cut: "e070/c2", gen: "g2", track: 1, kind: "video", dur: 5 },
  ] }));
  for (const method of ["load", "pause"] as const) vi.spyOn(HTMLMediaElement.prototype, method).mockImplementation(() => {});
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  flash = vi.fn();
  rows = [];
  Object.assign(team, { state: "ok", complete: true });
  vi.spyOn(api, "listEditShares").mockImplementation(async () => rows);
  vi.spyOn(api, "getEditShare").mockImplementation(async () => ({ data: null } as never));
  // 서버처럼 — 같은 내용이면 revision 그대로, 다르면 +1
  let last = { data: "", revision: 0 };
  vi.spyOn(api, "saveEditShare").mockImplementation(async (body) => {
    if (body.data !== last.data) last = { data: body.data, revision: last.revision + 1 };
    return savedHead(body.data, last.revision);
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  mount();
  press({ key: "Home", code: "Home" }); // 재생 위치는 앞 시험이 남긴 자리일 수 있다(엔진이 기억한다)
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  keepUnsavedEditDoc(DOC, null);
  clearUndo(DOC);
});

it("서버에 저장 — 고르면 한 번 저장 · 바뀌면 라임 → 누르면 다시 저장 · 같은 내용이면 보내지 않는다", async () => {
  expect(pill().textContent).toContain("나만 보는 편집");
  await choose("서버에 저장");
  const save = vi.mocked(api.saveEditShare);
  expect(save).toHaveBeenCalledTimes(1);
  const [body, expect_] = save.mock.calls[0];
  expect([body.project_id, body.seq, expect_]).toEqual(["p1", "e070", getAccountNamespace()]);
  expect((JSON.parse(body.data) as ShareSnapshot).cuts.map((cut) => cut.folder)).toEqual(["e070/c1", "e070/c2"]);
  expect(pill().textContent).toContain("서버에 저장");
  expect(pill().classList.contains("ed-lime")).toBe(false);

  act(() => pill().querySelector<HTMLButtonElement>(".ed-share-main")!.click());
  expect(save).toHaveBeenCalledTimes(1); // 같은 내용 — 보내지 않는다
  expect(flash).toHaveBeenCalledWith("저장됨 — 바뀐 것 없음");

  press({ key: "a", code: "KeyA", ctrlKey: true });
  press({ key: "d", code: "KeyD" }); // 클립을 끈다 — 보이는 것이 바뀐다
  await settle();
  expect(pill().classList.contains("ed-lime")).toBe(true);
  act(() => pill().querySelector<HTMLButtonElement>(".ed-share-main")!.click());
  await settle();
  expect(save).toHaveBeenCalledTimes(2);
  expect(pill().classList.contains("ed-lime")).toBe(false);

  await choose("나만 보는 편집"); // 저장 단추만 사라진다(서버의 것은 남는다)
  expect(pill().textContent).toContain("나만 보는 편집");
  expect(save).toHaveBeenCalledTimes(2);
});

it("응답 순서 — 저장 중 다시 고치면 라임이 남고, 늦게 온 옛 저장 응답·옛 revision 의 목록은 적용하지 않는다", async () => {
  const save = vi.mocked(api.saveEditShare);
  const first = deferred<Awaited<ReturnType<typeof api.saveEditShare>>>();
  save.mockImplementationOnce(() => first.promise);
  await choose("서버에 저장");
  const sentFirst = save.mock.calls[0][0].data;
  press({ key: "a", code: "KeyA", ctrlKey: true });
  press({ key: "d", code: "KeyD" }); // 저장이 도는 사이에 고쳤다
  await settle();
  first.resolve(await savedHead(sentFirst, 1));
  await settle();
  expect(pill().classList.contains("ed-lime")).toBe(true); // 보낸 것만 확인됐다 — 지금 것은 아직

  // 두 번 보낸다 — 앞(A)이 늦게 오면 버린다. 서버가 A 를 뒤에 처리했으면 목록이 따라온다(revision 3 > 2)
  const a = deferred<Awaited<ReturnType<typeof api.saveEditShare>>>();
  const b = deferred<Awaited<ReturnType<typeof api.saveEditShare>>>();
  save.mockImplementationOnce(() => a.promise).mockImplementationOnce(() => b.promise);
  act(() => pill().querySelector<HTMLButtonElement>(".ed-share-main")!.click());
  await settle();
  const sentA = save.mock.calls[1][0].data;
  expect(pill().querySelector<HTMLButtonElement>(".ed-share-main")!.disabled).toBe(true); // 도는 동안 단추로는 다시 못 보낸다
  press({ key: "d", code: "KeyD" }); // 다시 켠다
  await settle();
  await choose("서버에 저장"); // 목록에서 다시 고르면 겹쳐 보낼 수 있다 — 늦게 온 쪽을 버려야 한다
  const sentB = save.mock.calls[2][0].data;
  b.resolve(await savedHead(sentB, 2));
  await settle();
  expect(pill().classList.contains("ed-lime")).toBe(false);
  a.resolve(await savedHead(sentA, 3)); // 늦게 온 옛 응답 — 버린다
  await settle();
  expect(pill().classList.contains("ed-lime")).toBe(false);
  rows = [{ key: OTHER, name: "나", mine: true, ...(await savedHead(sentA, 1)) }]; // 옛 revision 의 목록 — 적용 안 함
  await focusWindow();
  expect(pill().classList.contains("ed-lime")).toBe(false);
  rows = [{ key: OTHER, name: "나", mine: true, ...(await savedHead(sentA, 3)) }]; // 서버에는 A 가 남았다(다른 창·늦은 처리) — 따라온다
  await focusWindow();
  expect(pill().classList.contains("ed-lime")).toBe(true);
});

it.each([
  [new HttpError(404, "Not Found"), "서버가 아직 이 기능을 모릅니다"],
  [new HttpError(401, "로그인이 필요합니다"), "공유 서버 로그인이 필요합니다"],
  [new HttpError(403, "x"), "권한이 없습니다"],
  [new HttpError(409, "공유 서버에 로그인하지 않아 서버에 저장할 수 없습니다"), "로그인하지 않아 서버에 저장할 수 없습니다"],
  [new HttpError(409, "화면과 허브의 계정이 달라 멈췄습니다. 새로 고쳐 주세요."), "계정이 달라 멈췄습니다"],
  [new HttpError(502, "x"), "연결하지 못했습니다"],
])("오류는 빈 목록으로 숨기지 않는다 — 화면 위 알림 줄로(막대에는 없다) · %s", async (error, text) => {
  vi.mocked(api.listEditShares).mockRejectedValue(error);
  await choose("다른 편집 보기");
  expect(notices.map((item) => item.text).join("\n")).toContain(text);
  expect([document.querySelector(".ed-share .ed-warn"), document.querySelector(".ed-bar")!.textContent!.includes(text)]).toEqual([null, false]);
});

it("다른 편집 보기 — V0 줄·알약·메뉴 두 줄 · 다른 작업자만 · 고르면 그 사람 타임라인 그대로 · 보기만 · 새로 저장되면 라임 → 최신", async () => {
  rows = [
    { key: "b".repeat(32), name: "나", revision: 1, data_hash: "h", updated_at: "2026-10-23T05:00:00.000Z", mine: true },
    { key: OTHER, name: "오지짱", revision: 1, data_hash: "h1", updated_at: "2026-10-23T05:20:00.000Z", mine: false },
  ];
  vi.mocked(api.getEditShare).mockImplementation(async () => ({ data: snapshot(8), revision: 1, data_hash: "h1", updated_at: "t" }));
  await choose("다른 편집 보기");
  expect(document.querySelector(".ed-v0chip")?.textContent).toBe("V0 — 작업자 선택");
  expect(document.querySelector(".ed-l-v0 .ed-v0-note")?.textContent).toBe("V0 — 작업자 선택");

  act(() => { document.querySelector(".ed-h-v0")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })); });
  const menu = document.querySelector<HTMLElement>('[role="menu"][aria-label="V0 트랙"]')!;
  expect([...menu.querySelectorAll(":scope > .ed-tmenu-item")].map((item) => item.textContent?.replace("›", "").trim())).toEqual(["작업자 선택", "트랙 색"]);
  act(() => (menu.querySelector(":scope > .ed-tmenu-item") as HTMLButtonElement).click());
  const workers = [...document.querySelectorAll<HTMLButtonElement>('[aria-label="서버에 저장한 작업자"] [role="menuitemradio"]')];
  expect(workers.map((item) => item.textContent)).toEqual([expect.stringContaining("오지짱")]); // 나(mine)는 없다
  act(() => workers[0].click());
  await settle();
  expect(vi.mocked(api.getEditShare)).toHaveBeenCalledWith("p1", "e070", OTHER, getAccountNamespace());
  expect(document.querySelector(".ed-v0chip")?.textContent).toBe("V0 · 오지짱");
  expect(document.querySelector(".ed-h-v0 .ed-v0name")?.textContent).toBe("오지짱");
  const boxes = [...document.querySelectorAll<HTMLElement>(".ed-v0clip")];
  expect(boxes.map((box) => box.querySelector(".ed-clip-name")?.textContent)).toEqual(["c1", "c2"]);
  expect(boxes.every((box) => !box.dataset.clip)).toBe(true); // 고르기·끌기·길이 조절의 대상이 아니다
  expect(boxes[0].querySelector(".ed-clip-msg")?.textContent).toBe("확인 못 함"); // 내 팀 목록에 그 생성물이 없다

  press({ key: "a", code: "KeyA", ctrlKey: true });
  expect(document.querySelectorAll(".ed-clip.ed-sel").length).toBe(2); // 내 클립만
  expect(document.querySelectorAll(".ed-v0clip.ed-sel").length).toBe(0);

  rows = rows.map((row) => (row.mine ? row : { ...row, revision: 2 }));
  await focusWindow();
  expect(document.querySelector(".ed-v0chip")?.classList.contains("ed-lime")).toBe(true);
  vi.mocked(api.getEditShare).mockImplementation(async () => ({ data: snapshot(6), revision: 2, data_hash: "h2", updated_at: "t" }));
  act(() => document.querySelector<HTMLButtonElement>(".ed-v0chip")!.click());
  await settle();
  expect(document.querySelector(".ed-v0chip")?.classList.contains("ed-lime")).toBe(false);
});

it("V0 판·꼬리 — 더 긴 V0 은 재생 범위를 늘리고, 꼬리에서는 위치 편집을 넘기며, 끄면 정확히 내 끝으로", async () => {
  rows = [{ key: OTHER, name: "오지짱", revision: 1, data_hash: "h1", updated_at: "2026-10-23T05:20:00.000Z", mine: false }];
  vi.mocked(api.getEditShare).mockImplementation(async () => ({ data: snapshot(30), revision: 1, data_hash: "h1", updated_at: "t" }));
  localStorage.setItem("mvhub.editShare:auth:p1:e070", JSON.stringify({ others: true, owner: OTHER }));
  act(() => root.unmount());
  root = createRoot(host);
  mount();
  await settle();
  expect(document.querySelectorAll(".ed-v0clip").length).toBe(2);

  press({ key: "End", code: "End" });
  expect(timecode()).toBe("00:00:30:00"); // 내 편집(10초)보다 긴 V0 끝까지
  const marksBefore = localStorage.getItem(DOC);
  expect(press({ key: "i", code: "KeyI" }).defaultPrevented).toBe(false); // 꼬리 — 마크 인을 넘긴다
  expect(press({ key: "m", code: "KeyM" }).defaultPrevented).toBe(false);
  act(() => document.querySelector<HTMLButtonElement>(".ed-mbtn-in")!.click());
  expect(flash).toHaveBeenCalledWith("V0 끝 구간에서는 찍을 수 없습니다.");
  expect(localStorage.getItem(DOC)).toBe(marksBefore);

  act(() => document.querySelector<HTMLButtonElement>(".ed-h-v0 .ed-hbtn")!.click()); // 필름 단추 — 판을 V0 으로
  expect(document.querySelector('.ed-view[data-view="other"]')).not.toBeNull();
  expect(document.querySelector('.ed-view[data-view="other"]')?.textContent).toContain("V0 · 오지짱");

  await choose("다른 편집 보기"); // 끈다 — 꼬리가 사라지고 재생헤드는 정확히 내 끝
  expect(timecode()).toBe("00:00:10:00");
  expect(document.querySelector(".ed-h-v0")).toBeNull();
  expect(document.querySelector('.ed-view[data-view="other"]')?.textContent).toContain("다른 편집 보기가 꺼져 있습니다"); // 판은 그대로 — 안내
});

it("꼬리에 선 채 닫았다 다시 열면 적힌 위치는 내 끝이다(꼬리 자리를 적지 않는다)", async () => {
  rows = [{ key: OTHER, name: "오지짱", revision: 1, data_hash: "h1", updated_at: "t", mine: false }];
  vi.mocked(api.getEditShare).mockImplementation(async () => ({ data: snapshot(30), revision: 1, data_hash: "h1", updated_at: "t" }));
  localStorage.setItem("mvhub.editShare:auth:p1:e070", JSON.stringify({ others: true, owner: OTHER }));
  act(() => root.unmount());
  root = createRoot(host);
  mount();
  await settle();
  press({ key: "End", code: "End" });
  expect(timecode()).toBe("00:00:30:00");
  act(() => root.unmount());
  localStorage.setItem("mvhub.editShare:auth:p1:e070", JSON.stringify({ others: false }));
  root = createRoot(host);
  mount();
  await settle();
  expect(timecode()).toBe("00:00:10:00");
});

it("공유 화면 상태는 시퀀스마다 따로 · 시퀀스를 바꾼 뒤 늦게 온 목록은 버린다", async () => {
  const late = deferred<EditShareRow[]>();
  vi.mocked(api.listEditShares).mockImplementationOnce(() => late.promise);
  await choose("다른 편집 보기");
  expect(document.querySelector(".ed-h-v0")).not.toBeNull();
  const folder = [...document.querySelectorAll<HTMLButtonElement>(".ed-side .folder-tree-row")].find((row) => row.textContent?.includes("e080"))!;
  act(() => folder.click());
  await settle();
  expect(document.querySelector(".ed-h-v0")).toBeNull(); // e080 에서는 꺼져 있다
  late.resolve([{ key: OTHER, name: "늦은 응답", revision: 1, data_hash: "h", updated_at: "t", mine: false }]);
  await settle();
  expect(document.body.textContent).not.toContain("늦은 응답");
  expect(JSON.parse(localStorage.getItem("mvhub.editShare:auth:p1:e070")!).others).toBe(true);
});

// ── 독립 리뷰(Codex s1) 반례 ──────────────────────────────────────────────────────────────────────

const reopenWithV0 = async (data: string, revision = 1) => {
  vi.mocked(api.getEditShare).mockImplementation(async () => ({ data, revision, data_hash: `h${revision}`, updated_at: "t" }));
  localStorage.setItem("mvhub.editShare:auth:p1:e070", JSON.stringify({ others: true, owner: OTHER }));
  act(() => root.unmount());
  root = createRoot(host);
  mount();
  await settle();
};
const folderRow = (name: string) => [...document.querySelectorAll<HTMLButtonElement>(".ed-side .folder-tree-row")].find((row) => row.textContent?.includes(name))!;

it("저장 — 해시를 재는 사이 문맥(계정)이 바뀌면 보내지 않는다", async () => {
  const gate = deferred<void>();
  const real = crypto.subtle.digest.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "digest").mockImplementation(async (...args: Parameters<SubtleCrypto["digest"]>) => {
    await gate.promise;
    return real(...args);
  });
  await choose("서버에 저장");
  mount("other-account"); // 화면이 다른 계정으로 바뀌었다
  await settle();
  gate.resolve();
  await settle();
  expect(api.saveEditShare).not.toHaveBeenCalled();
});

it("저장 요청 본문에도 화면 계정을 싣는다 — 공유 서버에 바로 붙은 화면은 본문으로 대조한다", async () => {
  vi.mocked(api.saveEditShare).mockRestore();
  const sent = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ revision: 1, data_hash: "h", updated_at: "t" }),
    { status: 200, headers: { "Content-Type": "application/json" } }));
  await api.saveEditShare({ project_id: "p1", seq: "e070", data: "{}" }, "acct:a@example.com");
  const init = sent.mock.calls[0][1]!;
  expect(JSON.parse(String(init.body))).toEqual({ project_id: "p1", seq: "e070", data: "{}", expect_account: "acct:a@example.com" });
  expect((init.headers as Record<string, string>)["X-MVHub-Expect-Account"]).toBe("acct:a@example.com");
});

it("V0 — 받은 뒤 목록 읽기가 실패하면(권한 상실) V0·늘어난 재생 범위를 쓰지 않고 안내 · 풀리면 다시 · 처음부터 못 읽어도 안내", async () => {
  rows = [{ key: OTHER, name: "오지짱", revision: 1, data_hash: "h1", updated_at: "t", mine: false }];
  await reopenWithV0(snapshot(30));
  expect(document.querySelectorAll(".ed-v0clip").length).toBe(2);
  press({ key: "End", code: "End" });
  expect(timecode()).toBe("00:00:30:00");
  vi.mocked(api.listEditShares).mockRejectedValue(new HttpError(403, "x"));
  await focusWindow();
  expect(document.querySelectorAll(".ed-v0clip").length).toBe(0);
  expect(document.querySelector(".ed-l-v0 .ed-v0-note")?.textContent).toContain("권한이 없습니다");
  expect(timecode()).toBe("00:00:10:00"); // 꼬리가 사라졌다 — 정확히 내 끝
  vi.mocked(api.getEditShare).mockImplementation(async () => ({ data: snapshot(12), revision: 1, data_hash: "h1", updated_at: "t" }));
  const asked = vi.mocked(api.getEditShare).mock.calls.length;
  vi.mocked(api.listEditShares).mockImplementation(async () => rows);
  await focusWindow();
  expect(vi.mocked(api.getEditShare).mock.calls.length).toBe(asked + 1); // 풀리면 본문을 다시 받는다(옛 것을 그대로 되살리지 않는다)
  expect(document.querySelector(".ed-v0clip .ed-clip-bar b")?.textContent).toBe("6.0s");

  vi.mocked(api.getEditShare).mockRejectedValue(new HttpError(403, "x"));
  act(() => root.unmount());
  root = createRoot(host);
  mount();
  await settle();
  expect(document.querySelector(".ed-l-v0 .ed-v0-note")?.textContent).toContain("권한이 없습니다");
});

it("V0 본문 — 늦게 온 옛 응답(앞 요청·옛 revision)이 최신을 덮지 않는다", async () => {
  rows = [{ key: OTHER, name: "오지짱", revision: 1, data_hash: "h1", updated_at: "t", mine: false }];
  await reopenWithV0(snapshot(8));
  rows = [{ ...rows[0], revision: 3 }];
  await focusWindow();
  const chip = () => document.querySelector<HTMLButtonElement>(".ed-v0chip")!;
  expect(chip().classList.contains("ed-lime")).toBe(true);
  type Doc = Awaited<ReturnType<typeof api.getEditShare>>;
  const slow = deferred<Doc>();
  const fast = deferred<Doc>();
  vi.mocked(api.getEditShare).mockImplementationOnce(() => slow.promise).mockImplementationOnce(() => fast.promise);
  act(() => chip().click());
  act(() => chip().click()); // 아직 라임 — 한 번 더
  fast.resolve({ data: snapshot(6), revision: 3, data_hash: "h3", updated_at: "t" });
  await settle();
  slow.resolve({ data: snapshot(20), revision: 2, data_hash: "h2", updated_at: "t" });
  await settle();
  expect(document.querySelector(".ed-v0clip .ed-clip-bar b")?.textContent).toBe("3.0s"); // revision 3 의 c1(3초) 그대로
  expect(chip().classList.contains("ed-lime")).toBe(false);
});

it("V0 — 목록 읽기가 실패하기 전에 나간 본문 요청이 늦게 성공해도 오류를 지우지 못한다", async () => {
  rows = [{ key: OTHER, name: "오지짱", revision: 2, data_hash: "h2", updated_at: "t", mine: false }];
  await reopenWithV0(snapshot(8)); // 받은 것은 revision 1 — 목록은 2 라 라임
  const chip = () => document.querySelector<HTMLButtonElement>(".ed-v0chip")!;
  expect(chip().classList.contains("ed-lime")).toBe(true);
  const late = deferred<Awaited<ReturnType<typeof api.getEditShare>>>();
  vi.mocked(api.getEditShare).mockImplementationOnce(() => late.promise);
  act(() => chip().click()); // 본문 요청이 나갔다
  vi.mocked(api.listEditShares).mockRejectedValue(new HttpError(403, "x"));
  await focusWindow(); // 그 뒤 목록이 403
  late.resolve({ data: snapshot(30), revision: 2, data_hash: "h2", updated_at: "t" });
  await settle();
  expect(document.querySelectorAll(".ed-v0clip").length).toBe(0);
  expect(document.querySelector(".ed-l-v0 .ed-v0-note")?.textContent).toContain("권한이 없습니다");
  press({ key: "End", code: "End" });
  expect(timecode()).toBe("00:00:10:00"); // 늦게 온 30초짜리로 재생 범위가 늘지 않았다
});

it("V0 — 끈 뒤 늦게 온 본문은 버리고, 다시 켜면 새로 받는다", async () => {
  rows = [{ key: OTHER, name: "오지짱", revision: 2, data_hash: "h2", updated_at: "t", mine: false }];
  const late = deferred<Awaited<ReturnType<typeof api.getEditShare>>>();
  vi.mocked(api.getEditShare).mockImplementationOnce(() => late.promise)
    .mockImplementation(async () => ({ data: snapshot(12), revision: 2, data_hash: "h2", updated_at: "t" }));
  localStorage.setItem("mvhub.editShare:auth:p1:e070", JSON.stringify({ others: true, owner: OTHER }));
  act(() => root.unmount());
  root = createRoot(host);
  mount();
  await settle();
  const asked = vi.mocked(api.getEditShare).mock.calls.length;
  await choose("다른 편집 보기"); // 끈다 — 본문 요청은 아직 돈다
  late.resolve({ data: snapshot(8), revision: 1, data_hash: "h1", updated_at: "t" });
  await settle();
  await choose("다른 편집 보기"); // 다시 켠다
  expect(vi.mocked(api.getEditShare).mock.calls.length).toBe(asked + 1);
  expect(document.querySelector(".ed-v0clip .ed-clip-bar b")?.textContent).toBe("6.0s"); // 늦게 온 옛 것(4.0s)이 아니라 새로 받은 것
});

it("보안 문맥이 아닌 화면(crypto.subtle 없음)에서도 저장·라임이 그대로 — 해시는 JS 로 잰다", async () => {
  vi.stubGlobal("crypto", { getRandomValues: crypto.getRandomValues.bind(crypto), randomUUID: crypto.randomUUID.bind(crypto) });
  try {
    await choose("서버에 저장");
    expect(api.saveEditShare).toHaveBeenCalledTimes(1);
    expect(pill().classList.contains("ed-lime")).toBe(false); // 응답의 hash = 보낸 글자의 hash 로 확인됐다
    press({ key: "a", code: "KeyA", ctrlKey: true });
    press({ key: "d", code: "KeyD" });
    await settle();
    expect(pill().classList.contains("ed-lime")).toBe(true);
    act(() => pill().querySelector<HTMLButtonElement>(".ed-share-main")!.click());
    await settle();
    expect(api.saveEditShare).toHaveBeenCalledTimes(2);
    expect(pill().classList.contains("ed-lime")).toBe(false);
  } finally {
    vi.unstubAllGlobals();
  }
});

it("저장 — 고친 직후 해시를 재는 사이에 눌러도 '바뀐 것 없음'이 아니라 보낸다", async () => {
  await choose("서버에 저장");
  expect(api.saveEditShare).toHaveBeenCalledTimes(1);
  const gate = deferred<void>();
  const real = crypto.subtle.digest.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "digest").mockImplementation(async (...args: Parameters<SubtleCrypto["digest"]>) => {
    await gate.promise;
    return real(...args);
  });
  press({ key: "a", code: "KeyA", ctrlKey: true });
  press({ key: "d", code: "KeyD" }); // 보이는 것이 바뀌었다 — 해시는 아직
  act(() => pill().querySelector<HTMLButtonElement>(".ed-share-main")!.click());
  expect(flash).not.toHaveBeenCalledWith("저장됨 — 바뀐 것 없음");
  gate.resolve();
  await settle();
  expect(api.saveEditShare).toHaveBeenCalledTimes(2);
});

it("작업자를 바꾸면 새 사람의 것이 올 때까지 범위를 쥐고, 온 뒤 정확히 새 끝으로 — 중간에 내 끝으로 줄지 않는다", async () => {
  const B = "c".repeat(32);
  rows = [
    { key: OTHER, name: "오지짱", revision: 1, data_hash: "h1", updated_at: "t", mine: false },
    { key: B, name: "비비", revision: 1, data_hash: "hb", updated_at: "t", mine: false },
  ];
  await reopenWithV0(snapshot(30));
  press({ key: "End", code: "End" });
  expect(timecode()).toBe("00:00:30:00");
  const second = deferred<Awaited<ReturnType<typeof api.getEditShare>>>();
  vi.mocked(api.getEditShare).mockImplementationOnce(() => second.promise);
  act(() => { document.querySelector(".ed-h-v0")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })); });
  const menu = document.querySelector<HTMLElement>('[role="menu"][aria-label="V0 트랙"]')!;
  act(() => (menu.querySelector(":scope > .ed-tmenu-item") as HTMLButtonElement).click());
  const workers = [...document.querySelectorAll<HTMLButtonElement>('[aria-label="서버에 저장한 작업자"] [role="menuitemradio"]')];
  act(() => workers.find((item) => item.textContent?.includes("비비"))!.click());
  await settle();
  expect(timecode()).toBe("00:00:30:00"); // 받는 중 — 그대로
  second.resolve({ data: snapshot(20), revision: 1, data_hash: "hb", updated_at: "t" });
  await settle();
  expect(timecode()).toBe("00:00:20:00");
  expect(document.querySelector(".ed-v0chip")?.textContent).toBe("V0 · 비비");
});

it("확인된 내 것 — 저장 응답(revision 3)과 옛 목록(revision 2)이 한 화면 사이에 잇달아 와도 최신을 지킨다", async () => {
  type Head = Awaited<ReturnType<typeof api.saveEditShare>>;
  const saved = deferred<Head>();
  const listed = deferred<EditShareRow[]>();
  vi.mocked(api.saveEditShare).mockImplementationOnce(() => saved.promise);
  vi.mocked(api.listEditShares).mockImplementationOnce(() => listed.promise);
  await choose("서버에 저장");
  const sent = vi.mocked(api.saveEditShare).mock.calls[0][0].data;
  const head = await savedHead(sent, 3);
  await act(async () => {
    saved.resolve(head);
    listed.resolve([{ key: OTHER, name: "나", mine: true, revision: 2, data_hash: "old", updated_at: "t" }]);
    for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(pill().classList.contains("ed-lime")).toBe(false);
  expect(JSON.parse(localStorage.getItem("mvhub.editShare:auth:p1:e070")!).confirmed.revision).toBe(3);
});

it("꼬리에 선 채 다른 시퀀스로 가면 그 시퀀스의 적힌 위치로 간다 — 앞 시퀀스의 꼬리 시각으로 새 끝을 덮지 않는다", async () => {
  localStorage.setItem("mvhub.editDoc:local:p1:e080", JSON.stringify({ v: 1, tracksOff: [], tracksLocked: [], clips: [
    { cut: "e080/k9", gen: "k9", track: 1, kind: "video", dur: 4 }, { cut: "e080/k10", gen: "k10", track: 1, kind: "video", dur: 4 },
  ] }));
  act(() => folderRow("e080").click());
  await settle();
  act(() => document.querySelector<HTMLButtonElement>('[data-cut="e080/k10"]')!.click());
  expect(timecode()).toBe("00:00:04:00");
  rows = [{ key: OTHER, name: "오지짱", revision: 1, data_hash: "h1", updated_at: "t", mine: false }];
  vi.mocked(api.getEditShare).mockImplementation(async () => ({ data: snapshot(30), revision: 1, data_hash: "h1", updated_at: "t" }));
  localStorage.setItem("mvhub.editShare:auth:p1:e070", JSON.stringify({ others: true, owner: OTHER }));
  act(() => folderRow("e070").click());
  await settle();
  press({ key: "End", code: "End" });
  expect(timecode()).toBe("00:00:30:00");
  act(() => folderRow("e080").click());
  await settle();
  expect(timecode()).toBe("00:00:04:00");
});

it.each([
  [{ state: "loading", complete: false }, "확인 중"],
  [{ state: "capped", complete: false }, "목록이 많아 일부 확인 못 함"],
  [{ state: "ok", complete: true }, "확인 못 함"],
])("V0 링크 — 내 팀 목록이 %o 이면 '%s'", async (state, text) => {
  Object.assign(team, state);
  rows = [{ key: OTHER, name: "오지짱", revision: 1, data_hash: "h1", updated_at: "t", mine: false }];
  await reopenWithV0(snapshot(8));
  expect(document.querySelector(".ed-v0clip .ed-clip-msg")?.textContent).toBe(text);
});

it("V0 그림 줄은 조각 길이대로 나뉘고 빈 조각은 비운다 · 이름 없는 작업자", async () => {
  rows = [{ key: OTHER, name: "", revision: 1, data_hash: "h1", updated_at: "t", mine: false }];
  await reopenWithV0(JSON.stringify({ v: 1, total: 6, cuts: [{ name: "c1", folder: "e070/c1", len: 6, parts: [
    { len: 2, gen: "g1", kind: "video", head: 0 }, { len: 4, gap: true },
  ] }] } satisfies ShareSnapshot));
  const parts = [...document.querySelectorAll<HTMLElement>(".ed-v0clip .ed-v0part")];
  expect(parts.map((part) => [part.style.flexGrow, part.classList.contains("ed-v0gap")])).toEqual([["2", false], ["4", true]]);
  expect(document.querySelector(".ed-v0chip")?.textContent).toBe("V0 · 이름 없는 작업자");
});

it("내 편집이 비어 있어도 V0 꼬리만으로 재생된다 — 정방향은 끝에서·역방향은 처음에서 멈추고, 반복은 처음으로", () => {
  const tail = withTail(buildLayout([], emptyEditDoc()), 3);
  let clock = 1000;
  let frames: ((stamp: number) => void)[] = [];
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  vi.stubGlobal("requestAnimationFrame", (callback: (stamp: number) => void) => frames.push(callback));
  vi.stubGlobal("cancelAnimationFrame", () => { frames = []; });
  const frame = (ms: number) => act(() => {
    clock += ms;
    const due = frames;
    frames = [];
    due.forEach((callback) => callback(clock));
  });
  let playback!: ReturnType<typeof useEditPlayback>;
  const videoRef = { current: null };
  function Probe({ loop }: { loop: boolean }) {
    playback = useEditPlayback({ scope: "tail-only", layout: tail, doc: emptyEditDoc(), videoRef, paint: () => {}, loop, ephemeral: TAIL_KEY,
      sourceOf: () => ({ state: "ok", url: null, type: null, thumb: null }) });
    return null;
  }
  try {
    act(() => root.render(<Probe loop={false} />));
    act(() => playback.toggle());
    frame(1000);
    expect(playback.now()).toBeCloseTo(1);
    frame(5000);
    expect(playback.view.playing).toBe(false);
    expect(playback.now()).toBeCloseTo(3);
    act(() => playback.shuttle(-1));
    frame(1000);
    expect(playback.now()).toBeCloseTo(2);
    frame(5000);
    expect(playback.view.playing).toBe(false);
    expect(playback.now()).toBe(0);
    act(() => root.render(<Probe loop />));
    act(() => playback.toggle());
    frame(2500);
    frame(1000); // 끝(3초)을 넘었다 — 처음으로 돌아 이어 튼다
    expect(playback.view.playing).toBe(true);
    expect(playback.now()).toBeLessThan(3);
  } finally {
    vi.unstubAllGlobals();
  }
});

it("따라가는 판은 배치의 끝 이상에서 비어 있다 — 꺼진 긴 클립이 정확한 끝에 비치지 않는다", () => {
  // 컷 길이 5초(켜진 클립) · 꺼진 V2 클립 9초 — trackClip 은 끔을 보지 않아 끝(5초)에서도 V2 를 골랐다
  const layout: EditLayout = buildLayout(["s/c1"], { v: 1, tracksOff: [], tracksLocked: [], clips: [
    { cut: "s/c1", gen: "on", track: 1, kind: "video", dur: 5 }, { cut: "s/c1", gen: "long", track: 2, kind: "video", dur: 9, off: true },
  ] });
  let time = 4.9;
  const seen: (string | null)[] = [];
  function Probe() {
    const ref = useRef<HTMLVideoElement>(null);
    const shown = useEditFollow({ videoRef: ref, layout, track: 2, sourceOf: () => ({ state: "ok", url: null, type: "video", thumb: null }), now: () => time, playing: false, rate: 1 });
    seen.push(shown.clip?.gen ?? null);
    return <video ref={ref} />;
  }
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
  try {
    act(() => root.render(<Probe />));
    act(() => { vi.advanceTimersToNextFrame(); });
    expect(seen.at(-1)).toBe("long");
    time = 5;
    act(() => { vi.advanceTimersToNextFrame(); });
    expect(seen.at(-1)).toBeNull();
    time = 12;
    act(() => { vi.advanceTimersToNextFrame(); });
    expect(seen.at(-1)).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});
