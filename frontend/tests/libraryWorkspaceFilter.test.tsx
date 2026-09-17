// @vitest-environment jsdom
import { act } from "react";
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LibraryToolbar } from "../src/components/LibraryToolbar";
import { LibraryWorkspaceFilter } from "../src/components/common/LibraryWorkspaceFilter";
import { setLang } from "../src/lib/i18n";
import { restoreFilters } from "../src/lib/useLibraryFilters";
import {
  FILTERS_FORMAT,
  FILTERS_FORMAT_KEY,
  FILTERS_KEY,
  LEGACY_FILTERS_KEY,
  useLibraryPersistence,
} from "../src/lib/useLibraryPersistence";
import type { Store } from "../src/lib/storage";

// 툴바 워크스페이스 필터(Jay 2026-09-14) — 등록 절차 없이 내 워크스페이스에서 **여러 개**를 고른다.
//
// ★여기서 지키는 계약.
//  1. 고른 값이 **새로고침 뒤에도 살아남는다**. 전역태그 침(`#+` 등록)이 없어도 그렇다.
//  2. 옛 릴리스로 **롤백했다 돌아와도** 선택이 섞이지 않는다 — 저장 키를 분리한다.
//  3. 목록 **조회가 실패해도 걸린 필터를 풀지 않는다**.
//  4. 화면은 **[칩 3개][+N][버튼(개수)]** 이고 회색 dot 왼쪽에 붙는다.
//  5. `+N` 에 가려졌거나 목록에 없는 선택도 **메뉴에서 뺄 수 있다**.

function fakeStore(data: Record<string, string>): Store {
  return {
    get: (k, fallback) => data[k] ?? fallback,
    set: (k, v) => void (data[k] = v),
    loadJSON: <T,>(k: string) => (k in data ? (JSON.parse(data[k]) as T) : null),
    setJSON: (k, v) => void (data[k] = JSON.stringify(v)),
    loadSet: () => new Set<string>(),
    setSet: () => {},
  };
}

const stored = (value: unknown) => JSON.stringify(value);

describe("저장 복원 — 형식별 한 번씩만 이사한다", () => {
  it("형식 2(새 키)는 배열을 그대로 되살린다", () => {
    const store = fakeStore({
      [FILTERS_KEY]: stored({ tab: "my", workspace_ids: ["a", "b"], [FILTERS_FORMAT_KEY]: "2" }),
    });
    expect(restoreFilters(store).workspace_ids).toEqual(["a", "b"]);
  });

  it("형식 1(단수)은 등록 침이 없어도 배열로 옮긴다", () => {
    const store = fakeStore({
      [LEGACY_FILTERS_KEY]: stored({ tab: "my", workspace_id: "a", [FILTERS_FORMAT_KEY]: "1" }),
    });
    expect(restoreFilters(store).workspace_ids).toEqual(["a"]);
  });

  it("형식 0(표식 없음)은 등록 침이 없으면 잔재로 보고 버린다", () => {
    const store = fakeStore({ [LEGACY_FILTERS_KEY]: stored({ tab: "my", workspace_id: "a" }) });
    expect(restoreFilters(store).workspace_ids).toBeUndefined();
  });

  it("형식 0이어도 등록된 침이면 배열로 옮긴다", () => {
    const store = fakeStore({
      [LEGACY_FILTERS_KEY]: stored({ tab: "my", workspace_id: "a" }),
      workspaceChips: stored([{ id: "a", name: "뻘뻘뻘" }]),
    });
    expect(restoreFilters(store).workspace_ids).toEqual(["a"]);
  });

  it("새 키가 있으면 옛 키는 아예 안 본다 — 롤백했다 돌아와도 안 섞인다", () => {
    // 옛 릴리스(v1)는 옛 키만 쓴다. 새 키가 살아 있으면 그쪽이 정답이어야 한다.
    const store = fakeStore({
      [FILTERS_KEY]: stored({ tab: "my", workspace_ids: ["new"], [FILTERS_FORMAT_KEY]: "2" }),
      [LEGACY_FILTERS_KEY]: stored({ tab: "my", workspace_id: "old", [FILTERS_FORMAT_KEY]: "1" }),
    });
    expect(restoreFilters(store).workspace_ids).toEqual(["new"]);
  });

  it("손상된 저장값을 걸러낸다 — 빈 값·중복·문자열 아닌 것", () => {
    // loadJSON 은 JSON 파싱만 하고 모양은 확인하지 않는다. 손상값이 그대로 들어온다.
    const store = fakeStore({
      [FILTERS_KEY]: stored({
        tab: "my",
        workspace_ids: ["a", "", "  ", "a", 7, null],
        [FILTERS_FORMAT_KEY]: "2",
      }),
    });
    expect(restoreFilters(store).workspace_ids).toEqual(["a"]);
  });

  it("형식 번호는 상태로 들이지 않는다 (조회 쿼리로 새지 않게)", () => {
    const store = fakeStore({
      [FILTERS_KEY]: stored({ tab: "my", workspace_ids: ["a"], [FILTERS_FORMAT_KEY]: "2" }),
    });
    expect(FILTERS_FORMAT_KEY in restoreFilters(store)).toBe(false);
  });
});

function persistenceProbe(store: Store, filters: { tab: "my"; workspace_ids?: string[] }) {
  function Probe() {
    useLibraryPersistence({
      armedAutoTags: new Set<string>(),
      armedFolder: null,
      colorFilter: new Set<string>(),
      workspaceChips: [],
      commentOnly: false,
      fill: true,
      filters,
      finalOnly: false,
      grayOn: false,
      groupByDate: false,
      layout: "grid",
      sharedOnly: false,
      showFilters: true,
      store,
      tagFilter: new Set<string>(),
      typeFilter: "all",
      scale: 1,
    });
    return null;
  }
  const probeHost = document.createElement("div");
  document.body.appendChild(probeHost);
  const probeRoot = createRoot(probeHost);
  act(() => probeRoot.render(<Probe />));
  act(() => probeRoot.unmount());
  probeHost.remove();
}

describe("저장 — 형식 표식을 값과 같은 JSON 에 남긴다", () => {
  it("새 키에 형식 표식과 함께 저장한다", () => {
    const data: Record<string, string> = {};
    const store = fakeStore(data);
    persistenceProbe(store, { tab: "my", workspace_ids: ["a", "b"] });
    expect(JSON.parse(data[FILTERS_KEY])[FILTERS_FORMAT_KEY]).toBe(FILTERS_FORMAT);
    expect(restoreFilters(store).workspace_ids).toEqual(["a", "b"]);
    // 옛 키는 건드리지 않는다 — 롤백하면 그쪽 선택이 그대로 살아 있어야 한다.
    expect(data[LEGACY_FILTERS_KEY]).toBeUndefined();
  });

  it("저장이 실패하면 표식도 안 남는다 — 옛 잔재 청소가 다음 로드에 다시 돈다", () => {
    // Store 는 예외를 삼킨다(storage.ts). 표식을 따로 쓰면 '청소된 값은 저장 실패 + 표식만
    // 성공' 이 되어 옛 workspace_id 가 되살아난다. 한 JSON 이면 그럴 수 없다.
    const data: Record<string, string> = {
      [LEGACY_FILTERS_KEY]: stored({ tab: "my", workspace_id: "old" }),
    };
    const store = { ...fakeStore(data), setJSON: () => {} };
    persistenceProbe(store, { tab: "my" });
    expect(data[FILTERS_KEY]).toBeUndefined();
    expect(restoreFilters(store).workspace_ids).toBeUndefined(); // 청소가 다시 돈다
  });
});

const OPTIONS = [
  { id: "ws-1", name: "뻘뻘뻘" },
  { id: "ws-2", name: "MILLION VOLT" },
  { id: "ws-3", name: "R&D" },
  { id: "ws-4", name: "산해학원" },
];

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  setLang("ko");
  vi.unstubAllGlobals();
});

function render(props: Partial<Parameters<typeof LibraryWorkspaceFilter>[0]> = {}) {
  const onToggle = props.onToggle ?? vi.fn();
  const onClear = props.onClear ?? vi.fn();
  act(() => {
    root.render(
      <div className="assets-filters">
        <LibraryWorkspaceFilter
          value={props.value ?? []}
          options={props.options ?? OPTIONS}
          loading={props.loading ?? false}
          failed={props.failed ?? false}
          onOpen={props.onOpen ?? vi.fn()}
          onToggle={onToggle}
          onClear={onClear}
          follow={props.follow}
        />
        <button className="af-dot af-dot-gray" />
      </div>,
    );
  });
  return { onToggle, onClear };
}

const openMenu = () =>
  act(() => {
    host.querySelector<HTMLButtonElement>(".lib-ws-btn")!.click();
  });

const items = () => Array.from(host.querySelectorAll<HTMLButtonElement>(".lib-ws-item"));
const itemNamed = (text: string) => items().find((el) => el.textContent?.includes(text))!;

describe("워크스페이스 필터 — 여러 개를 고른다", () => {
  it("버튼을 누르면 내 워크스페이스가 전부 나온다", () => {
    render();
    expect(host.querySelector(".lib-ws-menu")).toBeNull();
    openMenu();
    const names = items().map((el) => el.textContent);
    expect(names[0]).toBe("All"); // 설명 문구 없이 이름만 (Jay 2026-09-14)
    expect(names.join("|")).toContain("뻘뻘뻘");
    expect(names.join("|")).toContain("MILLION VOLT");
  });

  it("항목을 누르면 넣고 빼기를 알리고, 메뉴는 **안 닫힌다**", () => {
    // 여러 개를 이어서 고르는 일이 흔하다 — 하나 고를 때마다 닫히면 그때마다 다시 열어야 한다.
    const { onToggle } = render({ value: ["ws-1"] });
    openMenu();
    act(() => itemNamed("MILLION VOLT").click());
    expect(onToggle).toHaveBeenCalledWith("ws-2");
    expect(host.querySelector(".lib-ws-menu")).not.toBeNull();

    act(() => itemNamed("뻘뻘뻘").click()); // 이미 고른 것 → 빼기
    expect(onToggle).toHaveBeenCalledWith("ws-1");
  });

  it("고른 항목에 체크 표시가 붙는다", () => {
    render({ value: ["ws-2"] });
    openMenu();
    expect(itemNamed("MILLION VOLT").getAttribute("aria-checked")).toBe("true");
    expect(itemNamed("뻘뻘뻘").getAttribute("aria-checked")).toBe("false");
    expect(itemNamed("MILLION VOLT").querySelector(".lib-ws-check")).not.toBeNull();
  });

  it("'전체' 는 모두 해제하고 메뉴를 닫는다", () => {
    const { onClear } = render({ value: ["ws-1", "ws-2"] });
    openMenu();
    act(() => items()[0].click()); // 첫 항목 = All
    expect(onClear).toHaveBeenCalled();
    expect(host.querySelector(".lib-ws-menu")).toBeNull();
  });

  it("칩은 3개까지 + 나머지는 +N, 버튼에는 고른 개수", () => {
    render({ value: ["ws-1", "ws-2", "ws-3", "ws-4"] });
    const group = host.querySelector(".assets-filters")!;
    const order = Array.from(group.children).map((el) => el.className.split(" ")[0]);
    expect(order).toEqual(["lib-ws-chip", "lib-ws-chip", "lib-ws-chip", "lib-ws-more", "lib-ws-wrap", "af-dot"]);
    expect(host.querySelector(".lib-ws-more")!.textContent).toBe("+1");
    expect(host.querySelector(".lib-ws-count")!.textContent).toBe("4");
  });

  it("칩 ✕ 는 그 하나만 뺀다 (전체 해제가 아니다)", () => {
    const { onToggle, onClear } = render({ value: ["ws-1", "ws-2"] });
    act(() => host.querySelectorAll<HTMLButtonElement>(".lib-ws-chip-x")[1].click());
    expect(onToggle).toHaveBeenCalledWith("ws-2");
    expect(onClear).not.toHaveBeenCalled();
  });

  it("목록에 없는 선택도 메뉴에 나와 뺄 수 있다", () => {
    // +N 에 가려졌거나 탈퇴한 공간이면, 메뉴에도 없으면 영영 못 푼다.
    const { onToggle } = render({ value: ["ws-1", "ws-2", "ws-3", "gone"], options: OPTIONS });
    openMenu();
    const orphan = items().find(
      (el) => el.querySelector(".lib-ws-item-name")?.textContent === "…",
    );
    expect(orphan).toBeDefined();
    expect(orphan!.getAttribute("aria-checked")).toBe("true");
    act(() => orphan!.click());
    expect(onToggle).toHaveBeenCalledWith("gone");
  });

  it("목록 조회가 실패해도 걸린 필터를 풀지 않는다", () => {
    const { onToggle, onClear } = render({ value: ["ws-1"], options: [], failed: true });
    expect(host.querySelector(".lib-ws-chip")).not.toBeNull();
    expect(onToggle).not.toHaveBeenCalled();
    expect(onClear).not.toHaveBeenCalled();
    openMenu();
    expect(host.querySelector(".lib-ws-note.warn")!.textContent).toContain("다시 시도");
  });

  it("아무것도 안 골랐으면 칩도 개수도 없다", () => {
    render({ value: [] });
    expect(host.querySelector(".lib-ws-chip")).toBeNull();
    expect(host.querySelector(".lib-ws-count")).toBeNull();
    expect(host.querySelector(".lib-ws-btn")!.className).not.toContain("on");
  });
});

describe("공유&리뷰 워크스페이스 자동 필터", () => {
  it("자동 모드는 W 이름·자동 버튼 하나만 표시하고 기존 수동 칩과 ✕는 표시하지 않는다", () => {
    render({ value: ["ws-1", "ws-2"], follow: { mode: "auto", label: "R&D", onChange: vi.fn() } });
    const button = host.querySelector<HTMLButtonElement>(".lib-ws-btn")!;
    expect(button.textContent).toBe("WR&D· 자동▾");
    expect(button.classList.contains("on")).toBe(true);
    expect(button.title).toContain("R&D · 자동");
    expect(host.querySelectorAll(".lib-ws-btn")).toHaveLength(1);
    expect(host.querySelector(".lib-ws-chip")).toBeNull();
    expect(host.querySelector(".lib-ws-chip-x")).toBeNull();
    expect(host.querySelector(".lib-ws-count")).toBeNull();
  });

  it("메뉴는 자동/전체 두 항목이며 목록 재조회나 다른 워크스페이스 선택을 하지 않는다", () => {
    const onOpen = vi.fn();
    const onChange = vi.fn();
    const { onToggle, onClear } = render({ onOpen, follow: { mode: "auto", label: "R&D", onChange } });
    openMenu();
    expect(items()).toHaveLength(2);
    expect(items().map((item) => item.getAttribute("role"))).toEqual(["menuitemradio", "menuitemradio"]);
    expect(items().map((item) => item.getAttribute("aria-checked"))).toEqual(["true", "false"]);
    expect(host.querySelector(".lib-ws-follow-note")!.textContent).toBe("워크스페이스 변경 시 자동 적용으로 돌아갑니다.소속 미확인 생성물은 전체 보기에서 확인할 수 있습니다.");
    expect(onOpen).not.toHaveBeenCalled();
    act(() => itemNamed("전체 보기").click());
    expect(onChange).toHaveBeenCalledExactlyOnceWith("all");
    expect(onToggle).not.toHaveBeenCalled();
    expect(onClear).not.toHaveBeenCalled();
    expect(host.querySelector(".lib-ws-menu")).toBeNull();
    expect(document.activeElement).toBe(host.querySelector(".lib-ws-btn"));
  });

  it("전체 보기 상태를 수동으로 분명히 표시하고 다시 자동을 선택할 수 있다", () => {
    const onChange = vi.fn();
    render({ follow: { mode: "all", label: "R&D", onChange } });
    const button = host.querySelector<HTMLButtonElement>(".lib-ws-btn")!;
    expect(button.textContent).toBe("W전체 보기· 수동▾");
    expect(button.classList.contains("on")).toBe(false);
    openMenu();
    expect(items().map((item) => item.getAttribute("aria-checked"))).toEqual(["false", "true"]);
    act(() => itemNamed("현재 워크스페이스 따라가기").click());
    expect(onChange).toHaveBeenCalledExactlyOnceWith("auto");
    expect(host.querySelector(".lib-ws-menu")).toBeNull();
  });

  it("현재 공간 확인 중에는 이전 이름 대신 확인 중으로 표시하며 선택을 임의로 풀지 않는다", () => {
    const onChange = vi.fn();
    render({ follow: { mode: "auto", label: "이전 공간", pending: true, onChange } });
    const button = host.querySelector<HTMLButtonElement>(".lib-ws-btn")!;
    expect(button.textContent).toBe("W확인 중· 자동▾");
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.title).not.toContain("이전 공간");
    expect(onChange).not.toHaveBeenCalled();
    render({ follow: { mode: "auto", label: "새 공간", pending: false, onChange } });
    expect(host.querySelector(".lib-ws-btn")!.textContent).toBe("W새 공간· 자동▾");
    expect(host.querySelector(".lib-ws-btn")!.getAttribute("aria-busy")).toBe("false");
  });

  it("영어 모드에서도 공간 이름은 보존하고 동작 문구만 번역한다", () => {
    setLang("en");
    render({ follow: { mode: "auto", label: "우리팀", onChange: vi.fn() } });
    expect(host.querySelector(".lib-ws-btn")!.textContent).toBe("W우리팀· Auto▾");
    openMenu();
    expect(itemNamed("Follow current workspace")).toBeDefined();
    expect(itemNamed("Show all")).toBeDefined();
    expect(host.querySelector(".lib-ws-follow-note")!.textContent).toBe("Switching workspaces restores automatic filtering.Items with an unknown workspace are available in All.");
  });

  it("Escape는 메뉴만 닫고 버튼으로 포커스를 돌려주며 모드를 변경하지 않는다", () => {
    const onChange = vi.fn();
    render({ follow: { mode: "auto", label: "R&D", onChange } });
    openMenu();
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => window.dispatchEvent(event));
    expect(host.querySelector(".lib-ws-menu")).toBeNull();
    expect(document.activeElement).toBe(host.querySelector(".lib-ws-btn"));
    expect(event.defaultPrevented).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("메뉴 바깥을 누르면 선택을 바꾸지 않고 메뉴만 닫는다", () => {
    const onChange = vi.fn();
    render({ follow: { mode: "auto", label: "R&D", onChange } });
    openMenu();
    act(() => document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(host.querySelector(".lib-ws-menu")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("긴 이름은 줄임표로, 모드 표시는 고정 폭으로 남기고 툴바 버튼은 두 줄로 나누지 않는다", () => {
    // jsdom은 실제 폭을 배치하지 않으므로 CSS 계약만 확인한다. 실제 좁은 창은 브라우저 검증 대상.
    const style = document.createElement("style");
    style.textContent = readFileSync(new NodeURL("../src/styles/assets.css", import.meta.url), "utf8");
    document.head.appendChild(style);
    try {
      const label = "R&D 아주 긴 워크스페이스 이름 확인";
      render({ follow: { mode: "auto", label, onChange: vi.fn() } });
      const button = host.querySelector<HTMLButtonElement>(".lib-ws-btn")!;
      expect(button.title).toContain(label);
      expect(getComputedStyle(button).whiteSpace).toBe("nowrap");
      expect(getComputedStyle(button).maxWidth).toBe("240px");
      expect(getComputedStyle(host.querySelector(".lib-ws-follow-name")!).textOverflow).toBe("ellipsis");
      expect(getComputedStyle(host.querySelector(".lib-ws-follow-name")!).minWidth).toBe("0");
      expect(getComputedStyle(host.querySelector(".lib-ws-follow-mode")!).flexShrink).toBe("0");
      expect(getComputedStyle(host.querySelector(".assets-filters")!).flexWrap).toBe("wrap");
    } finally {
      style.remove();
    }
  });
});

// ── 툴바 배선 ────────────────────────────────────────────────────────────────
// 컴포넌트가 멀쩡해도 툴바가 안 그리면 기능은 없는 것과 같다. 그리고 **구성 보드 툴바에는
// 안 나와야** 한다 — 그쪽은 워크스페이스 조건 배선 자체가 없어 눌러도 아무 일도 안 일어난다.
function toolbarProps(workspaceFilter?: Parameters<typeof LibraryWorkspaceFilter>[0]) {
  const noop = () => {};
  return {
    typeFilter: "all" as const,
    onTypeFilter: noop,
    scale: 1,
    onScale: noop,
    fill: true,
    onToggleFill: noop,
    layout: "grid" as const,
    onLayout: noop,
    groupByDate: false,
    onToggleGroupByDate: noop,
    filtersOpen: true,
    onToggleFilters: noop,
    count: 0,
    loading: false,
    failedCount: 0,
    onClearFailed: noop,
    workspaceFilter,
    colorDots: [],
    colorFilter: new Set<string>(),
    onToggleColor: noop,
    sharedOnly: false,
    onToggleShared: noop,
    commentOnly: false,
    onToggleComment: noop,
    grayOn: false,
    onToggleGray: noop,
    hasUnread: false,
    tags: [],
    tagFilter: new Set<string>(),
    onSelectTag: noop,
    onDeleteTag: noop,
    onClearTags: noop,
    tagPanelOpen: false,
    onToggleTagPanel: noop,
  };
}

describe("툴바 배선", () => {
  it("공유&리뷰 자동 필터도 회색 dot 앞에 버튼 하나로 배선된다", () => {
    act(() => root.render(
      <LibraryToolbar {...toolbarProps({
        value: ["ws-3"], options: OPTIONS, loading: false, failed: false,
        onOpen: vi.fn(), onToggle: vi.fn(), onClear: vi.fn(),
        follow: { mode: "auto", label: "R&D", onChange: vi.fn() },
      })} />,
    ));
    const group = host.querySelector(".assets-filters")!;
    expect(Array.from(group.children).slice(0, 2).map((el) => el.className.split(" ")[0])).toEqual(["lib-ws-wrap", "af-dot"]);
    expect(host.querySelector(".lib-ws-follow-name")!.textContent).toBe("R&D");
    expect(host.querySelector(".lib-ws-chip")).toBeNull();
  });

  it("라이브러리 툴바는 회색 dot 왼쪽에 [칩…][버튼] 을 그린다", () => {
    act(() => {
      root.render(
        <LibraryToolbar
          {...toolbarProps({
            value: ["ws-1", "ws-2"],
            options: OPTIONS,
            loading: false,
            failed: false,
            onOpen: vi.fn(),
            onToggle: vi.fn(),
            onClear: vi.fn(),
          })}
        />,
      );
    });
    const group = host.querySelector(".assets-filters")!;
    const kinds = Array.from(group.children).map((el) => el.className.split(" ")[0]);
    expect(kinds.slice(0, 4)).toEqual(["lib-ws-chip", "lib-ws-chip", "lib-ws-wrap", "af-dot"]);
    expect(host.querySelector(".af-dot-gray")).not.toBeNull();
  });

  it("구성 보드 툴바(주지 않음)에는 아예 안 나온다", () => {
    act(() => {
      root.render(<LibraryToolbar {...toolbarProps(undefined)} boardMode />);
    });
    expect(host.querySelector(".lib-ws-btn")).toBeNull();
    expect(host.querySelector(".lib-ws-chip")).toBeNull();
  });
});
