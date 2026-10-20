// @vitest-environment jsdom
// 편집 탭의 최종 확정(Jay 2026-10-13) — 클립 우클릭 메뉴의 '최종 선택' · 목록 단추(☰)의 '타임라인 최종 확정'.
//  길은 앱의 것이다(review.apply = 공유 & 리뷰의 여러 장 등급 처리 — 요청·부분 실패 안내·다시 받기는 tests/generationReviewUI 가 본다).
//  여기서는 편집 탭이 **무엇을 언제 넘기는지**만 본다: 권한이 없으면 줄이 없다 · 무엇이 대상인가 · 확인 창의 숫자 · 아니오 = 넘기지 않음.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EditCardMenu } from "../src/components/timeline/EditTab";
import type { ReviewAction } from "../src/lib/generationReview";
import type { EditTree } from "../src/lib/useEditSequence";
import type { Generation } from "../src/types";

const gen = (id: string, cut: string, extra: Partial<Generation> = {}) => ({
  id, job_id: `job-${id}`, status: "done", params: {}, prompt: `prompt ${id}`, folder_path: `e070/${cut}`, project_id: "p1",
  shared: true, is_final: false, is_held: false, is_mine: false, tags: [], creator_name: "리버", model: "seedance",
  assets: [{ id: `a-${id}`, generation_id: id, type: "image", file_path: `/media/${id}.png`,
    thumbnail_path: null, source_url: null, cached: true }],
  ...extra,
} as unknown as Generation);

const world = vi.hoisted(() => ({ gens: [] as unknown[], state: "ok" }));
vi.mock("../src/lib/resolveTransfer", async () => ({
  ...(await vi.importActual<typeof import("../src/lib/resolveTransfer")>("../src/lib/resolveTransfer")),
  getResolveConnectionStatus: () => Promise.reject(new Error("안 물었다")),
}));
vi.mock("../src/lib/useEditSequence", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/useEditSequence")>("../src/lib/useEditSequence");
  const counts = { final: 0, held: 0, shared: 2 };
  const tree = { state: "ready", complete: true, note: null, roots: [{
    name: "e070", path: "e070", count: 6, newCount: 0, reviewCounts: counts, children: ["c1", "c2", "c3"].map((name) => (
      { name, path: `e070/${name}`, count: 2, newCount: 0, reviewCounts: counts })) }] } as unknown as EditTree;
  return {
    ...actual,
    useEditProjects: () => ({
      projects: [{ id: "p1", name: "P1" }], projectsState: "ok", tree, reload: () => {}, reloadCounts: () => {}, freshByProject: {},
    }),
    useEditGenerations: () => ({ state: world.state, gens: world.gens, error: null, complete: true, known: true, reload: () => {} }),
  };
});
vi.mock("../src/lib/useDisabledFolders", () => ({ useDisabledFolders: () => ({}) }));

import { EditTab } from "../src/components/timeline/EditTab";

let host: HTMLDivElement;
let root: Root;
const flashed: string[] = [];
const cardMenuRef: { current: EditCardMenu | null } = { current: null };
// 앱의 등급 처리 대역 — 넘겨받은 것을 적고, 시험이 끝내 줄 때까지 도는 중이다
const applied: { ids: string[]; action: ReviewAction | "release" }[] = [];
let finishApply: () => void = () => {};
let denied: ReadonlySet<string> = new Set(); // 내가 최종을 줄 수 없는 생성물
const review = {
  canFinalize: (item: Generation) => !denied.has(item.id),
  apply: (gens: Generation[], action: ReviewAction) => {
    applied.push({ ids: gens.map((item) => item.id).sort(), action });
    return new Promise<void>((resolve) => { finishApply = resolve; });
  },
  // 최종 해제(Jay 2026-10-14) — '공유로'와 다른 길이다: 최종 전에 보류였던 것은 보류로 돌아온다
  release: (gens: Generation[]) => {
    applied.push({ ids: gens.map((item) => item.id).sort(), action: "release" });
    return new Promise<void>((resolve) => { finishApply = resolve; });
  },
};
const mount = (withReview: typeof review | undefined = review) => act(() => root.render(
  <EditTab authKey="auth" authReady workspace={{ scope: "team", id: "w1", name: "W" }} keysActive
    flash={(message: string) => { flashed.push(message); }} onOpenCutFolder={() => {}} reloadSignal={0}
    peekPath={null} onPeekMarks={() => {}} cardMenuRef={cardMenuRef} onPreview={() => {}} onCompare={() => {}}
    resolve={{ send: () => {}, sendTimeline: () => new Promise<never>(() => {}), busy: false, pendingCount: 0, timelineBusy: false }}
    onFolderAction={() => {}} review={withReview} />,
));
const DOC_KEY = "mvhub.editDoc:local:p1:e070";
const seed = (clips: { cut: string; gen: string; track: number; off?: boolean; dur?: number }[], extra: Record<string, unknown> = {}) =>
  localStorage.setItem(DOC_KEY, JSON.stringify({
    v: 1, tracksOff: [], tracksLocked: [], ...extra,
    clips: clips.map((clip) => ({ kind: "image", dur: 5, ...clip, cut: `e070/${clip.cut}` })),
  }));
const fire = (target: EventTarget, type: string, init: MouseEventInit = {}) => {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: 1, ...init });
  act(() => { target.dispatchEvent(event); });
};
const clipOf = (id: string) => document.querySelector<HTMLElement>(`.ed-clip[title="prompt ${id}"]`)!;
const menuRows = () => [...document.querySelectorAll<HTMLButtonElement>(".ed-tmenu .ed-tmenu-item")];
const row = (label: string) => menuRows().find((item) => item.textContent!.replace(/^[★↔] /, "").startsWith(label)); // 줄 앞 표시는 빼고 본다
const openClipMenu = (id: string) => fire(clipOf(id), "contextmenu", { button: 2, buttons: 2, clientX: 40, clientY: 40 });
const pickClip = (id: string, additive = false) => {
  fire(clipOf(id), "pointerdown", { ctrlKey: additive });
  fire(clipOf(id), "pointerup", { ctrlKey: additive, buttons: 0 });
};
const openListMenu = () => act(() => document.querySelector<HTMLButtonElement>(".ed-listbtn")!.click());
const closeMenus = () => act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  localStorage.clear();
  localStorage.setItem("ch.editTimeline.last:local", JSON.stringify({ projectId: "p1", seq: "e070" }));
  for (const method of ["load", "pause"] as const) vi.spyOn(HTMLMediaElement.prototype, method).mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
  Object.assign(Element.prototype, { setPointerCapture() {}, hasPointerCapture: () => false, releasePointerCapture() {} });
  world.gens = [gen("a", "c1"), gen("f", "c2", { is_final: true })];
  world.state = "ok";
  applied.length = 0;
  flashed.length = 0;
  denied = new Set();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("최종을 줄 권한이 없으면 두 줄 모두 없다 — 다른 줄은 그대로다", () => {
  seed([{ cut: "c1", gen: "a", track: 1 }, { cut: "c2", gen: "f", track: 1 }]);
  denied = new Set(["a", "f"]);
  mount();
  openClipMenu("a");
  expect(menuRows().map((item) => item.textContent)).toEqual(["◆ Resolve 보내기", "↔ 길이 조절휠 클릭"]);
  closeMenus();
  openClipMenu("f"); // 이미 최종인 것도 내가 풀 수 없으면 줄이 없다
  expect(row("최종 선택")).toBeUndefined();
  closeMenus();
  openListMenu();
  expect(menuRows().map((item) => item.textContent!.replace(/[\d✓ ]+$/, ""))).toEqual(["비활성 숨기기", "빈 곳 채우기", "편집 파일 보관", "파일에서 편집 복원", "DB 백업 보기·복원"]);
  closeMenus();

  mount(undefined); // 앱이 그 길을 주지 않았다
  openClipMenu("a");
  expect(row("최종 선택")).toBeUndefined();
  closeMenus();
  openListMenu();
  expect(row("타임라인 최종 확정")).toBeUndefined();
  expect(applied).toEqual([]);
});

// Jay 2026-10-14: 타임라인의 클립에도 최종 ★ — 그 전에는 풀의 카드와 왼쪽 폴더 목록에만 보여, '모두 확정'을 눌러도 타임라인은 그대로였다.
it("최종인 생성물의 클립에는 ★ 표가 붙는다 — 최종이 아닌 클립·표보다 좁은 클립에는 없다", () => {
  world.gens = [gen("a", "c1"), gen("f", "c2", { is_final: true }), gen("n", "c3", { is_final: true })];
  seed([{ cut: "c1", gen: "a", track: 1 }, { cut: "c2", gen: "f", track: 1 }, { cut: "c3", gen: "n", track: 1, dur: 1 }]); // 20px/초 — 1초 클립은 18px
  mount();
  const star = (id: string) => clipOf(id).querySelector(".ed-clip-final");
  expect([!!star("a"), !!star("f"), !!star("n")]).toEqual([false, true, false]);
  expect(star("f")!.getAttribute("aria-label")).toBe("최종");
  expect(star("f")!.querySelector("svg.card-final-star")).not.toBeNull(); // 풀의 카드와 같은 별
});

it("클립 메뉴의 '최종 선택' — 누르면 그 생성물이 최종으로, 이미 최종이면 ✓ 이고 누르면 해제(공유로)", () => {
  seed([{ cut: "c1", gen: "a", track: 1 }, { cut: "c2", gen: "f", track: 1 }]);
  mount();
  openClipMenu("a");
  expect(menuRows().map((item) => item.textContent)).toEqual(["◆ Resolve 보내기", "↔ 길이 조절휠 클릭", "★ 최종 선택"]); // 줄 앞 표시(Jay 2026-10-14)
  expect(row("최종 선택")!.getAttribute("aria-checked")).toBe("false");
  act(() => row("최종 선택")!.click());
  expect(applied).toEqual([{ ids: ["a"], action: "final" }]);
  expect(document.querySelector(".ed-tmenu")).toBeNull(); // 고르면 닫힌다

  openClipMenu("f");
  expect(row("최종 선택")!.getAttribute("aria-checked")).toBe("true");
  expect(row("최종 선택")!.textContent).toBe("★ 최종 선택✓ ");
  act(() => row("최종 선택")!.click());
  expect(applied[1]).toEqual({ ids: ["f"], action: "release" }); // '공유로'(고른 전환)가 아니다 — 해제다
  expect(localStorage.getItem(DOC_KEY)).toContain('"gen":"a"'); // 편집 문서는 그대로다(되돌리기 단계가 아니다)
  expect(JSON.parse(localStorage.getItem(DOC_KEY)!).clips).toHaveLength(2);
});

it("여러 클립을 고른 채면 고른 것 전부에 — 해제는 최종인 것만 넘긴다(보류해 둔 것·내 권한 밖의 것은 건드리지 않는다)", () => {
  world.gens = [gen("a", "c1"), gen("f", "c2", { is_final: true }), gen("r", "c3", { is_held: true })];
  seed([{ cut: "c1", gen: "a", track: 1 }, { cut: "c2", gen: "f", track: 1 }, { cut: "c3", gen: "r", track: 1 }]);
  mount();
  pickClip("a");
  pickClip("f", true);
  pickClip("r", true);
  openClipMenu("f"); // 고른 것 위에서 — 셋 모두가 대상
  expect(row("최종 선택")!.textContent).toBe("★ 최종 선택2"); // 최종으로 올라갈 것 = a 와 보류해 둔 r
  expect(row("최종 선택")!.getAttribute("aria-checked")).toBe("false");
  act(() => row("최종 선택")!.click());
  expect(applied).toEqual([{ ids: ["a", "f", "r"], action: "final" }]); // 고른 것 전부를 넘긴다 — 무엇이 바뀌는지는 앱이 거른다

  denied = new Set(["a", "r"]); // 내가 줄 수 있는 것은 f 뿐이고 그것은 최종이다 → ✓
  mount();
  openClipMenu("f");
  expect(row("최종 선택")!.getAttribute("aria-checked")).toBe("true");
  act(() => row("최종 선택")!.click());
  expect(applied[1]).toEqual({ ids: ["f"], action: "release" }); // 최종인 f 만 — a·r 까지 넘기면 r 의 보류가 풀릴 수 있다
});

// 최종은 공유를 동반한다(서버가 공유가 없으면 같이 발행한다). 그사이 다른 창에서 공유를 푼 생성물이 옛 목록에 남아 있으면, 그것을
//  최종으로 올리는 것은 **다시 공유하는 것**이다 — 든 목록이 옛 것임을 아는 동안은 누르지 못한다(Codex 코드 리뷰 6회째).
it("공유 목록을 다시 받는 중·받지 못한 뒤에는 '최종 선택'을 누르지 못한다 — 옛 목록으로 넘기지 않는다", () => {
  seed([{ cut: "c1", gen: "a", track: 1 }, { cut: "c2", gen: "f", track: 1 }]);
  for (const state of ["loading", "error"]) { // 둘 다 앞서 받은 목록을 그대로 들고 있다
    world.state = state;
    mount();
    openClipMenu("a");
    expect(row("최종 선택")!.disabled).toBe(true);
    expect(row("최종 선택")!.title).toContain("공유 목록을 다시 받는 중이거나 받지 못했습니다");
    act(() => row("최종 선택")!.click());
    closeMenus();
    openClipMenu("f"); // 해제도 같다
    expect([row("최종 선택")!.disabled, row("최종 선택")!.getAttribute("aria-checked")]).toEqual([true, "true"]);
    act(() => row("최종 선택")!.click());
    closeMenus();
  }
  expect(applied).toEqual([]);

  world.state = "capped"; // 2,000건에서 잘린 목록은 받은 것이다(빈 곳 채우기와 같은 기준)
  mount();
  openClipMenu("a");
  expect(row("최종 선택")!.disabled).toBe(false);
  act(() => row("최종 선택")!.click());
  expect(applied).toEqual([{ ids: ["a"], action: "final" }]);
});

it("'타임라인 최종 확정' — 켜진 컷의 켜진 클립만 센다. 확인 창에 숫자를 보이고, 아니오면 아무것도 넘기지 않는다", async () => {
  world.gens = [gen("a", "c1"), gen("b", "c1"), gen("n", "c1"), gen("t", "c1"), gen("f", "c2", { is_final: true }), gen("x", "c2"), gen("h", "c3")];
  denied = new Set(["n"]);
  seed([
    { cut: "c1", gen: "a", track: 1 },
    { cut: "c1", gen: "b", track: 2, off: true }, // 꺼진 클립
    { cut: "c1", gen: "n", track: 3 }, // 내가 최종을 줄 수 없는 것
    { cut: "c1", gen: "t", track: 4 }, // 꺼진 트랙
    { cut: "c2", gen: "f", track: 1 }, // 이미 최종
    { cut: "c2", gen: "x", track: 2 },
    { cut: "c2", gen: "gone", track: 3 }, // 공유 목록에 없다
    { cut: "c3", gen: "h", track: 1 }, // 숨긴 컷
  ], { tracks: 4, tracksOff: [4], cutsOff: ["e070/c3"], hideOff: true });
  mount();
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  openListMenu();
  expect(row("타임라인 최종 확정")!.textContent).toBe("타임라인 최종 확정2"); // a · x
  act(() => row("타임라인 최종 확정")!.click());
  expect(document.querySelector(".ed-tmenu")).toBeNull();
  const asked = String(confirm.mock.calls[0][0]);
  for (const part of [
    "생성물 2개를 최종으로 확정할까요?", "켜진 클립 5개", "이미 최종인 1개", "꺼진 클립·트랙 2개", "숨긴 컷의 클립 1개",
    "권한이 없거나 공유가 풀린 것 1개", "공유 목록에서 못 찾은 클립 1개", "되돌리기(Ctrl+Z)로는 돌아가지 않습니다",
  ]) expect(asked).toContain(part);
  expect(applied).toEqual([]); // 아니오

  confirm.mockReturnValue(true);
  openListMenu();
  act(() => row("타임라인 최종 확정")!.click());
  expect(applied).toEqual([{ ids: ["a", "f", "n", "x"], action: "final" }]); // 켜진 클립의 생성물 — 꺼진 b·t, 숨긴 h, 못 찾은 것은 없다

  openListMenu(); // 도는 동안은 다시 누르지 못한다
  expect(row("타임라인 최종 확정")!.disabled).toBe(true);
  expect(row("타임라인 최종 확정")!.getAttribute("aria-busy")).toBe("true");
  closeMenus();
  await act(async () => { finishApply(); });
  openListMenu();
  expect(row("타임라인 최종 확정")!.disabled).toBe(false);
  expect(confirm).toHaveBeenCalledTimes(2);
  expect(flashed).toEqual([]);
});

// Jay 2026-10-14: 꺼 두기만 한(숨기지 않은) 컷의 클립은 타임라인에서 회색이다 — 그것이 최종이 되면 놀란다. 전날에는 들었다(재생되므로).
it("'타임라인 최종 확정' — 꺼 두기만 한 컷(숨기지 않음)의 클립도 뺀다. 확인 창이 그 수를 따로 적는다", () => {
  world.gens = [gen("a", "c1"), gen("k", "c2"), gen("m", "c3")];
  seed([{ cut: "c1", gen: "a", track: 1 }, { cut: "c2", gen: "k", track: 1 }, { cut: "c3", gen: "m", track: 1 }], { cutsOff: ["e070/c2"] });
  mount();
  expect(clipOf("k").className).toContain("ed-off"); // 화면에서 회색인 바로 그 클립이다
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  openListMenu();
  expect(row("타임라인 최종 확정")!.textContent).toBe("타임라인 최종 확정2"); // a · m — 꺼 둔 컷의 k 는 세지 않는다
  act(() => row("타임라인 최종 확정")!.click());
  const asked = String(confirm.mock.calls[0][0]);
  for (const part of ["생성물 2개를 최종으로 확정할까요?", "켜진 컷의 켜진 클립 2개", "꺼 둔 컷의 클립 1개"]) expect(asked).toContain(part);
  expect(asked).not.toContain("숨긴 컷"); // 숨긴 것은 없다 — 꺼 둔 것과 따로 센다
  expect(applied).toEqual([{ ids: ["a", "m"], action: "final" }]);
});

it("'타임라인 최종 확정' — 올릴 것이 없거나(전부 최종) 공유 목록을 다시 받는 중이면 흐리다", () => {
  seed([{ cut: "c1", gen: "a", track: 1 }, { cut: "c2", gen: "f", track: 1 }]);
  world.gens = [gen("a", "c1", { is_final: true }), gen("f", "c2", { is_final: true })];
  mount();
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  openListMenu();
  expect(row("타임라인 최종 확정")!.textContent).toBe("타임라인 최종 확정"); // 숫자 없음
  expect(row("타임라인 최종 확정")!.disabled).toBe(true);
  closeMenus();

  world.gens = [gen("a", "c1"), gen("f", "c2", { is_final: true })];
  world.state = "loading"; // 그동안 든 목록은 옛 것이다 — 빈 곳 채우기와 같이 기다린다
  mount();
  openListMenu();
  expect(row("타임라인 최종 확정")!.disabled).toBe(true);
  closeMenus();

  world.state = "ok";
  mount();
  openListMenu();
  expect(row("타임라인 최종 확정")!.textContent).toBe("타임라인 최종 확정1");
  expect(row("타임라인 최종 확정")!.disabled).toBe(false);
  expect([confirm.mock.calls.length, applied]).toEqual([0, []]);
});
