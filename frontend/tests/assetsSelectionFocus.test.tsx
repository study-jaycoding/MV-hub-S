// @vitest-environment jsdom
// Assets 격자 — 선택과 초점(Enter·#·c·Shift 의 기준)이 같은 파일을 가리킨다(조작 규칙 45).
// 2026-10-12 조작 점검 18회차(Codex 전수 검토): 초점은 목록의 '몇 번째'로 들고 있어, 목록이 바뀌면(비활성 숨기기·자동 새로 고침) 선택은
//  파일을 따라가는데 초점은 그 자리에 남아 다른 파일을 가리켰다. 끌어 고른(마퀴) 뒤에도 초점은 그 전에 누른 파일에 남았다.
// 실제 AssetsView 로 본다 — 바꾸는 것은 프로젝트 자료 읽기(서버)뿐이다.
import { act, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AssetNode, PreviewTarget } from "../src/types";

const fixture = vi.hoisted(() => ({
  tree: [] as unknown[], meta: {} as Record<string, unknown>, project: "P", metaReady: true, loading: false, noop: () => {},
  setTags: vi.fn(async () => {}), setColors: vi.fn(async () => ({ updated: 0, failed: [] })),
}));
vi.mock("../src/api", () => {
  const pending = () => new Promise(() => {});
  const urls: Record<string, unknown> = {
    assetFileUrl: (_project: string, path: string) => `/files/${path}`, assetThumbUrl: (_project: string, path: string) => `/thumbs/${path}`,
    setAssetTags: fixture.setTags, setAssetColorsBatch: fixture.setColors,
  };
  return { api: new Proxy(urls, { get: (target, name: string) => target[name] ?? pending }) };
});
vi.mock("../src/components/assets/useAssetProjectData", () => ({
  useAssetProjectData: () => ({
    error: "", loading: fixture.loading, meta: fixture.meta, metaReady: fixture.metaReady, project: fixture.project, projects: ["P", "Q"], linkedProjects: new Set<string>(), tree: fixture.tree,
    refreshProjectData: fixture.noop, reloadMeta: async () => true, reloadProjects: fixture.noop, reloadTree: fixture.noop, setMeta: fixture.noop, setProject: fixture.noop,
  }),
}));
vi.mock("virtua", async () => {
  const { forwardRef, useImperativeHandle } = await import("react");
  return { Virtualizer: forwardRef((props: { data: unknown[]; children: (row: unknown) => React.ReactNode }, ref) => {
    useImperativeHandle(ref, () => ({ scrollToIndex: () => {} }));
    return <>{props.data.map(props.children)}</>;
  }) };
});

import { AssetsView } from "../src/components/AssetsView";

let host: HTMLDivElement;
let root: Root;
let previews: string[];
let rerender: () => void;
const file = (name: string): AssetNode => ({ name, path: name, type: "image" }) as AssetNode;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("IntersectionObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("BroadcastChannel", undefined);
  localStorage.clear();
  localStorage.setItem("ch.assets.sortField", "name"); // 이름순 — a, b, c, d
  localStorage.setItem("ch.assets.sortDir", "asc");
  // 셀은 가로로 100px 마다 한 장(폭 80·높이 80) — 끌어 고르기(마퀴)가 화면 자리로 잰다
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const at = this.matches(".asset-cell") ? Number(this.dataset.idx) : -1;
    const [x, w, h] = at >= 0 ? [at * 100, 80, 80] : [0, 0, 0];
    return { x, y: 0, left: x, top: 0, width: w, height: h, right: x + w, bottom: h, toJSON: () => ({}) } as DOMRect;
  });
  fixture.tree = ["a.png", "b.png", "c.png", "d.png"].map(file);
  fixture.meta = {}; fixture.project = "P"; fixture.metaReady = true; fixture.loading = false;
  fixture.setTags.mockClear(); fixture.setColors.mockClear();
  previews = [];
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function Shell() {
  const [, bump] = useState(0);
  rerender = () => bump((n) => n + 1);
  return <AssetsView onInfo={() => {}} onPreview={(target: PreviewTarget) => previews.push(target.name ?? "")} />;
}
const mount = () => act(async () => { root.render(<Shell />); });
/** 목록이 바뀐다 — 자동 새로 고침·비활성 숨기기처럼 필터 조건은 그대로인 채 파일만 달라진다. */
const setFiles = (names: string[]) => act(async () => { fixture.tree = names.map(file); rerender(); });
const grid = () => host.querySelector<HTMLElement>(".assets-virtual")!;
const cells = () => [...host.querySelectorAll<HTMLElement>(".asset-cell")];
const names = () => cells().map((cell) => cell.querySelector<HTMLElement>(".asset-media")!.title);
const cell = (name: string) => cells().find((item) => item.querySelector<HTMLElement>(".asset-media")!.title === name)!;
const picked = () => cells().filter((item) => item.classList.contains("selected")).map((item) => item.querySelector<HTMLElement>(".asset-media")!.title);
const focusedName = () => cells().find((item) => item.classList.contains("focused"))?.querySelector<HTMLElement>(".asset-media")!.title ?? null;
const click = (name: string, init: MouseEventInit = {}) => act(async () => {
  cell(name).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX: 5, clientY: 5, ...init }));
  window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
});
/** 빈 곳에서 끌어 고른다 — (x0,90) → (x1,10): 그 가로 범위에 걸친 셀이 골라진다. */
const marquee = (x0: number, x1: number) => act(async () => {
  grid().dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX: x0, clientY: 90 }));
  window.dispatchEvent(new MouseEvent("mousemove", { clientX: x1, clientY: 10, buttons: 1 }));
  window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0, clientX: x1, clientY: 10 }));
});
const key = (init: KeyboardEventInit) => act(async () => {
  grid().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
});

it("목록이 바뀌면 초점도 그 파일을 따라간다 — 앞의 파일이 사라져도 Enter 는 고른 파일을 연다(전엔 그 자리에 온 다른 파일)", async () => {
  await mount();
  expect(names()).toEqual(["a.png", "b.png", "c.png", "d.png"]);
  await click("b.png");
  expect([picked(), focusedName()]).toEqual([["b.png"], "b.png"]);
  await setFiles(["b.png", "c.png", "d.png"]); // a 가 목록에서 빠졌다(비활성 숨기기·다른 창의 삭제)
  expect([picked(), focusedName()]).toEqual([["b.png"], "b.png"]); // 전엔 초점이 c.png 로 옮겨 갔다
  await key({ key: "Enter" });
  expect(previews).toEqual(["b.png"]);
  await key({ key: "ArrowDown" }); // 방향키도 그 파일에서 출발한다(시험의 격자는 한 줄에 한 장이다)
  expect(picked()).toEqual(["c.png"]); // 전엔 c 에서 출발해 d.png
});

// 20회차(Codex 전수 검토): 보던 자리(스크롤)는 스크롤이 멈추고 150ms 뒤에 저장된다. 파일 수가 바뀔 때마다 **저장된 자리로 되돌려서**,
//  방금 스크롤한 직후에 목록이 바뀌면(비활성 숨기기·자동 새로 고침) 화면이 옛 자리로 튀었다.
it("같은 화면에서 파일 수만 바뀌면 보던 스크롤 자리를 둔다 — 저장해 둔 옛 자리로 되돌리지 않는다. 화면을 다시 열면 저장된 자리로 간다", async () => {
  await mount();
  grid().scrollTop = 30;
  grid().dispatchEvent(new Event("scroll"));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); }); // 멈춘 지 150ms — 자리 30 이 저장됐다
  grid().scrollTop = 240; // 다시 여기까지 내렸다(저장은 150ms 뒤다 — 아직이다)
  await setFiles(["b.png", "c.png", "d.png"]); // 그 직후 목록이 바뀌었다(비활성 숨기기·자동 새로 고침)
  expect(grid().scrollTop).toBe(240); // 전엔 저장된 30 으로 튀었다

  // 격자가 내려갔다 다시 그려지면(빈 폴더를 거쳐 돌아옴 — 빈 폴더에는 격자 대신 안내가 그려진다) 새 격자는 저장된 자리로 간다(Codex 코드 리뷰)
  await setFiles([]);
  expect(host.querySelector(".assets-virtual")).toBeNull();
  await setFiles(["b.png", "c.png", "d.png"]);
  expect(grid().scrollTop).toBe(30);

  act(() => root.unmount()); // 화면을 닫았다 다시 연다 — 저장된 자리(30)에서 시작한다
  root = createRoot(host);
  await mount();
  expect(grid().scrollTop).toBe(30);

  // 받는 중에는 빈 격자가 먼저 그려진다 — 파일이 도착했을 때 저장된 자리로 간다(빈 격자에서 한 번 맞춘 것으로 끝내지 않는다)
  act(() => root.unmount());
  root = createRoot(host);
  fixture.tree = []; fixture.loading = true;
  await mount();
  grid().scrollTop = 0; // 빈 격자는 내려갈 곳이 없다(브라우저가 0 으로 자른다 — jsdom 은 자르지 않아 흉내 낸다)
  await act(async () => { fixture.loading = false; fixture.tree = ["b.png", "c.png", "d.png"].map(file); rerender(); });
  expect(grid().scrollTop).toBe(30);
});

it("초점이 놓인 파일이 목록에서 사라지면 초점을 내려놓는다 — 그 자리에 온 파일로 넘어가지 않는다", async () => {
  await mount();
  await click("b.png");
  await setFiles(["a.png", "c.png", "d.png"]);
  expect([picked(), focusedName()]).toEqual([[], null]);
  await key({ key: "Enter" });
  expect(previews).toEqual([]); // 전엔 c.png 가 열렸다
});

it("끌어 고른 뒤의 초점은 고른 것 중 마지막 파일이다 — Enter 가 고르지 않은 파일을 열지 않고, Shift 클릭이 거기서 출발한다", async () => {
  await mount();
  await click("a.png");
  await marquee(95, 285); // b·c 만 걸친다
  expect(picked()).toEqual(["b.png", "c.png"]);
  expect(focusedName()).toBe("c.png"); // 전엔 먼저 눌렀던 a.png
  await key({ key: "Enter" });
  expect(previews).toEqual(["c.png"]); // 전엔 고르지 않은 a.png 가 열렸다
  await click("d.png", { shiftKey: true });
  expect(picked()).toEqual(["c.png", "d.png"]); // 전엔 a~d 전부
});

it("끌었는데 아무것도 안 걸렸으면 초점도 없다", async () => {
  await mount();
  await click("a.png");
  await marquee(385, 395); // 빈 자리
  expect([picked(), focusedName()]).toEqual([[], null]);
});

// Codex 코드 리뷰: 끌어 고르기가 mouseup 없이 끝나도(창을 떠남) 선택은 이미 바뀌어 있다 — 초점도 같이 맞춘다.
it("끌어 고르다 창을 떠나도(blur) 초점은 고른 것 중 마지막 파일이다 — 놓친 끌기는 '클릭 판정'만 건너뛴다", async () => {
  await mount();
  await click("a.png");
  await act(async () => {
    grid().dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX: 95, clientY: 90 }));
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 285, clientY: 10, buttons: 1 }));
    window.dispatchEvent(new Event("blur")); // Alt+Tab
  });
  expect([picked(), focusedName()]).toEqual([["b.png", "c.png"], "c.png"]); // 전엔 a.png 에 남았다
  await key({ key: "Enter" });
  expect(previews).toEqual(["c.png"]);
});

// Codex 코드 리뷰: 끄는 사이 목록이 바뀌면(누른 채 d 로 숨김·자동 새로 고침) 끌 때 잰 번호는 다른 파일이다 — 경로로 다시 찾는다.
it("끌어 고르는 사이 고른 파일이 목록에서 사라지면, 놓을 때 초점이 그 자리에 온 다른 파일로 가지 않는다", async () => {
  await mount();
  await act(async () => {
    grid().dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX: 95, clientY: 90 }));
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 185, clientY: 10, buttons: 1 })); // b 만 걸친다
  });
  expect(picked()).toEqual(["b.png"]);
  await setFiles(["a.png", "c.png", "d.png"]); // 누른 채 b 가 목록에서 빠졌다
  await act(async () => { window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0, clientX: 185, clientY: 10 })); });
  expect([picked(), focusedName()]).toEqual([[], null]); // 전엔 b 의 자리에 온 c.png 가 초점이 됐다
  await key({ key: "Enter" });
  expect(previews).toEqual([]);
});

// Codex 코드 리뷰: 끌기가 누른 순간에 잡아 둔 것(시작 선택·기준·누른 칸)도 번호가 아니라 파일로 든다 — 누르고 있는 사이 목록이 바뀌면
//  번호는 다른 파일이다.
it("Shift 로 더해 고르는 끌기 중에 목록이 바뀌면, 시작할 때 고른 파일의 자리에 온 다른 파일이 골라지지 않는다", async () => {
  await mount();
  await click("b.png");
  await act(async () => {
    grid().dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, shiftKey: true, clientX: 385, clientY: 90 }));
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 395, clientY: 10, buttons: 1 })); // 빈 자리만 — 고른 것은 그대로 b
  });
  expect(picked()).toEqual(["b.png"]);
  await setFiles(["a.png", "c.png", "d.png"]); // 누른 채 b 가 목록에서 빠졌다
  await act(async () => {
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 396, clientY: 11, buttons: 1 })); // 조금 더 움직인다(여전히 빈 자리)
    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0, clientX: 396, clientY: 11 }));
  });
  expect([picked(), focusedName()]).toEqual([[], null]); // 전엔 b 의 번호(1)에 온 c.png 가 골라지고 초점도 갔다
});

it("파일을 누르고 있는 사이 그 파일이 목록에서 사라지면, 놓아도 그 자리에 온 다른 파일을 고르지 않는다 — 고른 것은 그대로다", async () => {
  await mount();
  await click("a.png");
  await act(async () => { cell("b.png").dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX: 105, clientY: 5 })); });
  await setFiles(["a.png", "c.png", "d.png"]);
  await act(async () => { window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 })); });
  expect([picked(), focusedName()]).toEqual([["a.png"], "a.png"]); // 전엔 c.png 가 골라졌다
});

// Codex 코드 리뷰: 선택·초점을 새 목록에 맞추는 일이 '그린 뒤'에 돌면, 새 목록은 그려졌는데 선택·초점은 아직 옛 번호인 한 박자가 생긴다 —
//  그때 누르면 끌기가 그 번호의 **다른 파일**을 시작 선택·기준으로 굳힌다. 맞추는 일은 그리기 전에 끝낸다(useLayoutEffect).
it("목록이 바뀐 바로 그 순간에 눌러도 끌기는 지금 목록의 파일을 잡는다 — 선택·초점이 옛 번호인 틈이 없다", async () => {
  await mount();
  await click("b.png");
  await act(async () => {
    flushSync(() => { fixture.tree = ["a.png", "c.png", "d.png"].map(file); rerender(); }); // b 가 빠진 목록이 그려졌다
    // 간격 0 — 다음 그리기를 기다리지 않고 바로 Shift 로 빈 자리를 끈다
    grid().dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, shiftKey: true, clientX: 385, clientY: 90 }));
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 395, clientY: 10, buttons: 1 }));
    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0, clientX: 395, clientY: 10 }));
  });
  expect([picked(), focusedName()]).toEqual([[], null]); // 전엔 b 의 번호(1)에 온 c.png 가 시작 선택으로 굳어 골라졌다
});

it("검색어를 바꾼 바로 그 순간에 눌러도 끌기는 풀린 선택에서 시작한다 — 조건이 바뀌면 선택을 푸는 일도 그리기 전에 끝난다", async () => {
  await mount();
  await click("b.png");
  const search = host.querySelector<HTMLInputElement>(".assets-search input")!;
  await act(async () => {
    flushSync(() => { // 검색어가 들어갔다 — 조건이 바뀌면 선택·초점을 푼다
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "png");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    grid().dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, shiftKey: true, clientX: 385, clientY: 90 }));
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 395, clientY: 10, buttons: 1 }));
    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0, clientX: 395, clientY: 10 }));
  });
  expect(names()).toEqual(["a.png", "b.png", "c.png", "d.png"]); // 네 장 다 검색에 걸린다
  expect([picked(), focusedName()]).toEqual([[], null]); // 전엔 풀리기 전의 선택(b)이 끌기의 시작 선택으로 굳어 다시 골라졌다
});

// ── 이 폴더의 메타(태그·색)를 받기 전 ──
// Codex 코드 리뷰: 폴더를 처음 열면 파일 목록이 메타보다 먼저 올 수 있다. 그 사이에 태그를 고치면 — 편집기는 열 때의 태그(아직 없다)를
//  사본으로 쥐고, 태그는 목록을 통째로 저장하므로 — 기존 태그가 지워진 목록이 나갔다. 받기 전에는 메타를 고치는 조작을 받지 않는다.
const tagInput = () => host.querySelector<HTMLInputElement>(".cs-tag-input");
const chips = () => [...host.querySelectorAll(".te-chip")].map((chip) => chip.firstChild!.textContent);
const metaOf = (tags: string[]) => ({ is_source: false, source_name: null, tags, comment: null, color: null, comment_count: 0, has_unread: false });
const flashes = () => {
  const seen: string[] = [];
  const onFlash = (event: Event) => { seen.push((event as CustomEvent<string>).detail); };
  window.addEventListener("ch:flash", onFlash);
  return { seen, stop: () => window.removeEventListener("ch:flash", onFlash) };
};

it("메타를 받기 전에는 태그 입력이 열리지 않고 색도 바뀌지 않는다 — 받은 뒤에 연 입력은 기존 태그에서 시작해, 더한 태그가 기존 태그를 지우지 않는다", async () => {
  fixture.metaReady = false; // 파일 목록만 먼저 왔다
  const flash = flashes();
  try {
    await mount();
    await click("b.png");
    await key({ key: "#" });
    expect(tagInput()).toBeNull(); // 전엔 빈 칩으로 열렸다
    await act(async () => { cell("b.png").querySelector<HTMLButtonElement>('button[title^="태그"], button.asset-t, .asset-btn-t')?.click(); });
    expect(tagInput()).toBeNull();
    await key({ key: "r" });
    expect(fixture.setColors).not.toHaveBeenCalled();
    expect(new Set(flash.seen)).toEqual(new Set(["이 폴더의 태그·색을 아직 받지 못했습니다 — 받은 뒤에 고칠 수 있습니다."]));

    await act(async () => { fixture.meta = { "b.png": metaOf(["old"]) }; fixture.metaReady = true; rerender(); }); // 메타가 왔다
    await key({ key: "#" });
    expect(chips()).toEqual(["old"]);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(tagInput()!, "new");
      tagInput()!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { tagInput()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
    expect(fixture.setTags).toHaveBeenLastCalledWith("P", "b.png", ["old", "new"]); // 전엔 ["new"] — old 가 지워졌다
  } finally {
    flash.stop();
  }
});

it("폴더를 바꾸면 열려 있던 태그 입력이 닫힌다 — 새 폴더에 같은 경로의 파일이 있어도 그 파일에 저절로 열리지 않는다", async () => {
  fixture.meta = { "b.png": metaOf(["p-tag"]) };
  await mount();
  await click("b.png");
  await key({ key: "#" });
  expect(tagInput()).not.toBeNull();
  await act(async () => { fixture.project = "Q"; fixture.meta = { "b.png": metaOf(["q-tag"]) }; rerender(); }); // 같은 경로의 파일이 있는 다른 폴더
  expect(names()).toContain("b.png");
  expect(tagInput()).toBeNull(); // 전엔 Q 의 b.png 에 입력이 열려 있었다
});