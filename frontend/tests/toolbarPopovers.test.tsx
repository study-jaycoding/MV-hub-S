// @vitest-environment jsdom
// 라이브러리 툴바의 단추 창 두 개(Jay 2026-10-30 — 힉스필드처럼). 기록: docs/status/툴바_보기창_필터창_2026-10-30.md
//  · 보기 단추(ViewControls · onSetMasonry 를 받는 툴바) — 단추 넷을 하나로: Layout(Square·Masonry·List, ✓ 없음) · Split by date · Fill · Card size(21눈금)
//  · 필터 단추(LibraryWorkspaceFilter) — Filter[Workspaces › · Hide failed] · Activity[실패·차단 정리 → 앱 확인 창(HostConfirm)]
//  · 받지 않은 툴바(Assets·캔버스·구성 보드)는 옛 단추 그대로 — 빨간 '실패·차단 정리'도 그쪽에만 남고 같은 확인 창을 띄운다
import { act } from "react";
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LibraryToolbar } from "../src/components/LibraryToolbar";
import { ViewControls } from "../src/components/common/ViewControls";
import { isFailedGeneration } from "../src/lib/generationDisplay";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const one = <T extends Element = HTMLElement>(selector: string) => document.body.querySelector<T>(selector);
const click = (el: Element | null) => act(() => { (el as HTMLElement).click(); });
const escape = () => act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
const press = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });

describe("보기 단추 창(ViewControls)", () => {
  type ViewProps = Parameters<typeof ViewControls>[0];
  const spies = () => ({ onToggleFit: vi.fn(), onScale: vi.fn(), onSelectLayout: vi.fn(), onToggleGroupByDate: vi.fn(), onSetMasonry: vi.fn() });
  const draw = (over: Partial<ViewProps> = {}) => act(() => root.render(
    <ViewControls fitContain={false} onToggleFit={() => {}} scale={1} onScale={() => {}} scaleMin={0.7} scaleMax={1.7} sizeTitle="카드 크기"
      layout="grid" groupByDate={false} onSelectLayout={() => {}} onToggleGroupByDate={() => {}} {...over} />,
  ));
  const openView = () => click(one(".vp-wrap .vp-btn"));
  const layoutItems = () => [...document.querySelectorAll<HTMLButtonElement>('.vp-pop [role="menuitemradio"]')];
  const option = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('.vp-pop [role="menuitemcheckbox"]')].find((el) => el.textContent === name)!;

  it("단추 하나 — 누르면 창, 고른 Layout 은 sel(✓ 없음) · 고르면 알리고 창은 열린 채", () => {
    const spy = spies();
    draw({ ...spy, onSetMasonry: spy.onSetMasonry });
    expect([one(".fit-toggle"), one(".size-slider"), one(".layout-toggle")]).toEqual([null, null, null]); // 단추 넷이 하나로
    expect(one(".vp-btn")!.className).toBe("af-btn vp-btn"); // S·T·C 와 같은 상자 단추
    expect(one(".vp-pop")).toBeNull();
    openView();
    expect(one(".vp-btn")!.className).toBe("af-btn vp-btn open"); // 연 동안 라임 테두리
    expect(layoutItems().map((el) => [el.textContent, el.classList.contains("sel"), el.getAttribute("aria-checked")])).toEqual([
      ["Square", true, "true"], ["Masonry", false, "false"], ["List", false, "false"],
    ]);
    expect(document.body.textContent).not.toContain("✓");
    click(layoutItems()[1]);
    expect([spy.onSelectLayout.mock.calls, spy.onSetMasonry.mock.calls]).toEqual([[["grid"]], [[true]]]);
    click(layoutItems()[2]);
    expect(spy.onSelectLayout).toHaveBeenLastCalledWith("list");
    expect(spy.onSetMasonry).toHaveBeenCalledTimes(1); // List 는 Masonry 값을 건드리지 않는다(그리드로 돌아오면 그대로)
    expect(one(".vp-pop")).not.toBeNull();
  });

  it("Split by date · Fill 스위치 — 값대로 켜지고 누르면 알린다 · Masonry 에선 Fill 이 흐리다", () => {
    const spy = spies();
    draw({ ...spy, groupByDate: true, fitContain: true });
    openView();
    expect([option("Split by date").getAttribute("aria-checked"), option("Fill").getAttribute("aria-checked")]).toEqual(["true", "false"]);
    expect([option("Split by date").querySelector(".vp-sw.on"), option("Fill").querySelector(".vp-sw.on")].map(Boolean)).toEqual([true, false]);
    click(option("Split by date"));
    click(option("Fill"));
    expect([spy.onToggleGroupByDate, spy.onToggleFit].map((fn) => fn.mock.calls.length)).toEqual([1, 1]);
    draw({ ...spy, masonry: true });
    expect(option("Fill").disabled).toBe(true);
    // Masonry 를 고른 동안 단추 그림 = Masonry(칸 넷이 아니라 폭이 다른 칸)
    expect(one(".vp-btn svg rect[width='11']")).not.toBeNull();
  });

  it("Card size(A안 — 상자 = 조절바) — 5% 단위 21눈금 · 100% 는 길게 · 값까지 채움 · 숫자 줄 없음 · 옮기면 알린다", () => {
    const spy = spies();
    draw({ ...spy, scale: 1.25 });
    openView();
    const ticks = [...document.querySelectorAll(".vp-ticks i")];
    expect(ticks).toHaveLength(21);
    expect(ticks.findIndex((i) => i.classList.contains("major"))).toBe(6);
    expect(one(".vp-val")!.textContent).toBe("125%");
    expect(parseFloat(one(".vp-size")!.style.getPropertyValue("--pct"))).toBeCloseTo(0.55); // 채움 = (125 − 70) ÷ 100
    expect([one(".vp-fill") !== null, one(".vp-marks"), one(".vp-size .size-slider")]).toEqual([true, null, null]);
    const range = one<HTMLInputElement>('.vp-size input[type="range"]')!;
    expect([range.min, range.max, range.step]).toEqual(["0.7", "1.7", "0.05"]);
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(range, "0.9");
      range.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(spy.onScale).toHaveBeenCalledWith(0.9);
  });

  it("Esc·바깥 누름으로 닫힌다", () => {
    const spy = spies();
    draw(spy);
    openView();
    escape();
    expect(one(".vp-pop")).toBeNull();
    openView();
    press(document.body);
    expect(one(".vp-pop")).toBeNull();
  });

  it("받지 않은 툴바(Assets·보드)는 옛 단추 그대로", () => {
    draw();
    expect([one(".vp-wrap"), !!one(".fit-toggle"), !!one(".size-slider"), document.querySelectorAll(".layout-toggle button").length]).toEqual([null, true, true, 2]);
  });
});

describe("필터 단추 창 · 실패·차단 정리(LibraryToolbar)", () => {
  const noop = () => {};
  const OPTIONS = [{ id: "ws-1", name: "AIVA project" }, { id: "ws-2", name: "MILLION VOLT" }];
  const toolbar = (over: Record<string, unknown> = {}) => ({
    typeFilter: "all" as const, onTypeFilter: noop, scale: 1, onScale: noop, fill: true, onToggleFill: noop, layout: "grid" as const, onLayout: noop,
    groupByDate: false, onToggleGroupByDate: noop, filtersOpen: true, onToggleFilters: noop, count: 0, loading: false, failedCount: 6, onClearFailed: noop,
    colorDots: [], colorFilter: new Set<string>(), onToggleColor: noop, sharedOnly: false, onToggleShared: noop, commentOnly: false, onToggleComment: noop,
    hasUnread: false, tags: [], tagFilter: new Set<string>(), onSelectTag: noop, onDeleteTag: noop, onClearTags: noop, tagPanelOpen: false, onToggleTagPanel: noop,
    ...over,
  });
  const workspaceFilter = { value: ["ws-2"], options: OPTIONS, loading: false, failed: false, onOpen: vi.fn(), onToggle: vi.fn(), onClear: vi.fn() };
  const draw = (over: Record<string, unknown> = {}) => act(() => root.render(<LibraryToolbar {...toolbar(over)} />));
  const openFilter = () => click(one(".lib-ws-btn"));
  const rowNamed = (name: string) => [...document.querySelectorAll<HTMLButtonElement>(".filter-pop .vp-item")].find((el) => el.textContent?.includes(name))!;

  it("필터 창 = Filter[Workspaces(고른 수) · Hide failed] · Activity[실패·차단 정리(N)] · 툴바의 빨간 단추는 없다", () => {
    const onToggleHideFailed = vi.fn();
    draw({ workspaceFilter, hideFailed: false, onToggleHideFailed });
    expect(one(".lib-clear-failed")).toBeNull();
    openFilter();
    expect([...document.querySelectorAll(".filter-pop .vp-head")].map((el) => el.textContent)).toEqual(["Filter", "Activity"]);
    expect([...document.querySelectorAll(".filter-pop .vp-item")].map((el) => el.textContent)).toEqual(["Workspaces1", "Hide failed", "실패·차단 정리6"]);
    expect(rowNamed("Hide failed").getAttribute("aria-checked")).toBe("false");
    click(rowNamed("Hide failed"));
    expect(onToggleHideFailed).toHaveBeenCalledTimes(1);
    draw({ workspaceFilter, hideFailed: true, onToggleHideFailed });
    expect(rowNamed("Hide failed").querySelector(".vp-sw.on")).not.toBeNull();
  });

  it("Workspaces 에 마우스를 올리면 옆 목록 — 고른 공간만 on(라임), 내리면 닫힌다", () => {
    draw({ workspaceFilter, onToggleHideFailed: noop });
    openFilter();
    const row = one(".filter-ws")!;
    act(() => { row.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body })); });
    const items = [...document.querySelectorAll(".filter-fly .lib-ws-item")];
    expect(items.map((el) => [el.textContent, el.classList.contains("on")])).toEqual([["All", false], ["AAIVA project", false], ["MMILLION VOLT", true]]);
    act(() => { row.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body })); });
    expect(one(".filter-fly")).toBeNull();
  });

  it("실패·차단 정리 → 필터 창은 닫히고 앱 확인 창 — 취소는 아무것도 안 하고 [정리]만 정리한다", () => {
    const onClearFailed = vi.fn();
    draw({ workspaceFilter, onToggleHideFailed: noop, onClearFailed });
    openFilter();
    click(rowNamed("실패·차단 정리"));
    expect(one(".filter-pop")).toBeNull();
    const dialog = one(".host-exit-confirm")!;
    expect(dialog.getAttribute("aria-label")).toBe("실패·차단 정리");
    expect(dialog.querySelector(".host-exit-text")!.textContent).toBe("실패·차단된 생성물 6건을 휴지통으로 보낼까요?휴지통 보기에서 되살릴 수 있고, 힉스필드 원본은 그대로입니다.");
    expect(document.activeElement?.textContent).toBe("정리"); // Enter = 정리(window.confirm 의 확인 자리)
    click(dialog.querySelector(".settings-action.ghost"));
    expect([one(".host-exit-confirm"), onClearFailed.mock.calls.length]).toEqual([null, 0]);
    openFilter();
    click(rowNamed("실패·차단 정리"));
    escape();
    expect([one(".host-exit-confirm"), onClearFailed.mock.calls.length]).toEqual([null, 0]); // Esc = 취소
    openFilter();
    click(rowNamed("실패·차단 정리"));
    click(one(".host-exit-confirm .settings-action.danger"));
    expect([one(".host-exit-confirm"), onClearFailed.mock.calls.length]).toEqual([null, 1]);
  });

  it("보기 단추는 S·T·C 와 같은 묶음(.assets-filters)의 끝 — 보드 툴바는 옛 단추가 묶음 밖 그대로", () => {
    draw({ workspaceFilter, onToggleHideFailed: noop, onSetMasonry: noop });
    expect(one(".assets-filters")!.lastElementChild!.className).toBe("vp-wrap");
    draw({ boardMode: true, onSetMasonry: noop });
    expect([one(".vp-wrap"), one(".assets-filters .fit-toggle"), !!one(".lib-tools > .fit-toggle")]).toEqual([null, null, true]);
  });

  it("보기 단추는 상자 없이 아이콘만 + 앞에 가는 세로선(S·T·C 와 다른 기능으로) — CSS", () => {
    const css = readFileSync(new NodeURL("../src/styles/generations.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.af-btn\.vp-btn \{[^}]*background: transparent; border-color: transparent;/);
    expect(css).toMatch(/\.assets-filters > \.vp-wrap \{[^}]*border-left: 1px solid/);
  });

  it("씬 캔버스 툴바는 크기 슬라이더·줌 묶음 없이 □ 만(줌은 네비게이터 위) — 히스토리 보드는 슬라이더 그대로", () => {
    draw({ boardMode: true, sceneCanvas: true });
    expect([!!one(".lib-tools > .fit-toggle"), one(".size-slider"), one(".zoom-cluster")]).toEqual([true, null, null]);
    draw({ boardMode: true });
    expect(!!one(".size-slider")).toBe(true);
  });

  it("정리할 것이 없으면 Activity 줄은 눌리지 않는다", () => {
    draw({ workspaceFilter, onToggleHideFailed: noop, failedCount: 0 });
    openFilter();
    expect(rowNamed("실패·차단 정리").disabled).toBe(true);
  });

  it("필터 창이 없는 툴바(캔버스·구성 보드)는 빨간 단추 그대로 — 같은 확인 창을 거친다", () => {
    const onClearFailed = vi.fn();
    draw({ boardMode: true, onClearFailed });
    click(one(".lib-clear-failed"));
    expect(onClearFailed).not.toHaveBeenCalled();
    click(one(".host-exit-confirm .settings-action.danger"));
    expect(onClearFailed).toHaveBeenCalledTimes(1);
  });
});

describe("실패·차단 판정(Hide failed)", () => {
  it("완료·대기·진행 중이 아닌 것 = 실패·차단(서버 정리 기준과 같다)", () => {
    expect(["done", "pending", "running", "failed", "nsfw", "blocked", "cancelled"].map((status) => isFailedGeneration({ status } as never)))
      .toEqual([false, false, false, true, true, true, true]);
  });
});
