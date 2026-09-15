// @vitest-environment jsdom
// 실제 ProjectAssignMenu 를 그려, 계산한 배치가 '진짜 메뉴에 적용되는지' 본다.
//  순수 함수 시험만 있으면 호출을 지워도 통과한다(코덱스 지적). 여기서 그 연결을 못 박는다.
//
// jsdom 은 getBoundingClientRect 가 전부 0 이라, 시험이 실제적인 rect 를 주입한다.
//  계산 함수 자체는 모의하지 않는다 — 그러면 아무것도 증명하지 못한다.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ProjectAssignMenu } from "../src/components/ProjectAssignMenu";
import type { Project } from "../src/types";

vi.mock("../src/api", () => ({
  api: {
    projectFolderLinks: vi.fn(async () => ({ links: {} })),
    projectFolder: vi.fn(async () => ({ tree: null })),
    projectFolderCounts: vi.fn(async () => ({ counts: {} })),
  },
}));

const PROJECTS: Project[] = Array.from({ length: 19 }, (_, i) => ({
  id: "p" + i,
  name: "Probe menu " + String(i).padStart(2, "0"),
})) as unknown as Project[];

// 폴더 보기 창을 흉내 낸다 — overflow:hidden 경계 안에 액션바가 맨 아래 붙은 모양.
const PEEK: DOMRect = { top: 53, bottom: 400, left: 20, right: 620, width: 600, height: 347,
  x: 20, y: 53, toJSON: () => ({}) } as DOMRect;
const BUTTON: DOMRect = { top: 362.406, bottom: 394.406, left: 120, right: 260, width: 140, height: 32,
  x: 120, y: 362.406, toJSON: () => ({}) } as DOMRect;

let root: Root;
let host: HTMLDivElement;
let peek: HTMLDivElement;

beforeEach(() => {
  peek = document.createElement("div");
  peek.className = "folder-peek";
  // jsdom 은 overflow 축약을 overflowX/Y 로 안 풀어준다 — 축별로 명시한다.
  peek.style.overflowX = "hidden";
  peek.style.overflowY = "hidden";
  document.body.appendChild(peek);
  host = document.createElement("div");
  peek.appendChild(host);
  root = createRoot(host);

  // 잘림 경계·단추 위치를 시험이 공급한다(jsdom 기본은 전부 0).
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (this.classList.contains("folder-peek")) return PEEK;
    if (this.tagName === "BUTTON" && (this.textContent || "").includes("프로젝트")) return BUTTON;
    if (this.classList.contains("proj-assign")) return BUTTON;
    return { top: 0, bottom: 0, left: 0, right: 0, width: 180, height: 0, x: 0, y: 0,
      toJSON: () => ({}) } as DOMRect;
  };
  // 메뉴가 원하는 높이 — 프로젝트 19개면 상한 320px 를 넘긴다.
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, value: 520 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 400 });
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 640 });
});

afterEach(() => {
  act(() => root.unmount());
  peek.remove();
  vi.restoreAllMocks();
});

const openMenu = async () => {
  await act(async () => {
    root.render(<ProjectAssignMenu projects={PROJECTS} onAssign={() => {}} />);
  });
  const btn = host.querySelector(".proj-assign button") as HTMLButtonElement;
  expect(btn, "'프로젝트에 담기' 단추가 있어야 한다").toBeTruthy();
  await act(async () => {
    btn.click();
  });
  return host.querySelector(".proj-assign-menu") as HTMLDivElement;
};

describe("ProjectAssignMenu — 잘림 경계 안에 들어가는가", () => {
  it("좁은 창에서 메뉴 높이가 가용 공간으로 제한된다", async () => {
    const menu = await openMenu();
    expect(menu, "메뉴가 열려야 한다").toBeTruthy();
    // 단추 top 362.406 − 경계 top 53 − 간격 6 = 303.406
    const maxH = parseFloat(menu.style.maxHeight);
    expect(maxH, "max-height 가 인라인으로 적용돼야 한다").toBeGreaterThan(0);
    expect(maxH).toBeLessThan(320);
    expect(maxH).toBeCloseTo(303.406, 1);
  });

  it("쓰지 않는 쪽은 auto 로 명시해 CSS 와 싸우지 않는다", async () => {
    const menu = await openMenu();
    const up = menu.style.bottom !== "auto";
    expect(up, "폴더 보기 아래쪽 단추는 위로 열려야 한다").toBe(true);
    expect(menu.style.top).toBe("auto");
  });

  it("창 크기가 바뀌면 다시 재서 값이 바뀐다", async () => {
    const menu = await openMenu();
    const before = parseFloat(menu.style.maxHeight);
    // 경계를 더 좁힌다 — 같은 메뉴가 더 눌려야 한다
    const tighter = { ...PEEK, top: 200, y: 200, height: 200 } as DOMRect;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      if (this.classList.contains("folder-peek")) return tighter;
      if (this.classList.contains("proj-assign")) return BUTTON;
      if (this.tagName === "BUTTON" && (this.textContent || "").includes("프로젝트")) return BUTTON;
      return { top: 0, bottom: 0, left: 0, right: 0, width: 180, height: 0, x: 0, y: 0,
        toJSON: () => ({}) } as DOMRect;
    };
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
      await new Promise((r) => setTimeout(r, 60));
    });
    const after = parseFloat(host.querySelector(".proj-assign-menu")!.getAttribute("style")!
      .match(/max-height:\s*([\d.]+)/)![1]);
    expect(after).toBeLessThan(before);
    expect(after).toBeCloseTo(362.406 - 200 - 6, 1);
  });

  it("닫으면 등록한 구독을 하나도 남기지 않는다", async () => {
    // ★닫으면 menuRef 가 비어 측정이 바로 빠져나간다 — "resize 가 조용하다" 로는
    //  누수를 못 잡는다(코덱스 지적). 등록/해제 짝을 직접 센다.
    const added: string[] = [];
    const removed: string[] = [];
    const origAdd = window.addEventListener.bind(window);
    const origRemove = window.removeEventListener.bind(window);
    const key = (t: string, o?: unknown) =>
      t + (typeof o === "object" && o !== null && (o as AddEventListenerOptions).capture ? ":capture"
        : o === true ? ":capture" : "");
    vi.spyOn(window, "addEventListener").mockImplementation((t, l, o) => {
      if (t === "resize" || t === "scroll") added.push(key(t as string, o));
      return origAdd(t as string, l as EventListener, o as AddEventListenerOptions);
    });
    vi.spyOn(window, "removeEventListener").mockImplementation((t, l, o) => {
      if (t === "resize" || t === "scroll") removed.push(key(t as string, o));
      return origRemove(t as string, l as EventListener, o as AddEventListenerOptions);
    });
    const disconnect = vi.fn();
    class FakeRO {
      observe() {}
      unobserve() {}
      disconnect() {
        disconnect();
      }
    }
    vi.stubGlobal("ResizeObserver", FakeRO);

    await openMenu();
    expect(added.length, "열 때 resize·scroll 을 등록해야 한다").toBeGreaterThanOrEqual(2);

    const btn = host.querySelector(".proj-assign button") as HTMLButtonElement;
    await act(async () => btn.click());
    expect(host.querySelector(".proj-assign-menu")).toBeNull();

    // 등록한 것과 해제한 것이 종류·capture 까지 같아야 한다
    expect(removed.sort()).toEqual(added.sort());
    expect(disconnect, "ResizeObserver 를 끊어야 한다").toHaveBeenCalled();
  });

  it("닫을 때 예약된 재측정(RAF)을 취소한다", async () => {
    const cancel = vi.spyOn(window, "cancelAnimationFrame");
    await openMenu();
    // 아직 실행되지 않은 재측정을 하나 예약시킨다
    window.dispatchEvent(new Event("resize"));
    const btn = host.querySelector(".proj-assign button") as HTMLButtonElement;
    await act(async () => btn.click());
    expect(cancel, "예약된 프레임을 취소해야 한다").toHaveBeenCalled();
  });
});
