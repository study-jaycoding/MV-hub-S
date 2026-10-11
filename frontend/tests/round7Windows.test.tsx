// @vitest-environment jsdom
// 조작 점검 7회차(2026-10-11) — 창·입력의 작은 수정 셋. 실제 컴포넌트를 붙여 본다.
//  · R7  계보 보드에서 Esc 가 선택을 풀지 않았다 — 보드의 선택은 보드가 쥐고 있는데 그 Esc 를 듣는 곳이 없었다
//        (라이브러리의 Esc 는 라이브러리 선택만 비운다).
//  · R9  설정 옆 패널이 낮은 창에서 아래가 잘렸다 — 높이 한도가 화면 전체 기준이라, 열린 뒤 내용이 늘면 화면 밖으로 나갔다.
//  · R16 업데이트 진행 덮개(Esc 로 닫히지 않는다) 뒤의 설정 창이 Esc 에 닫혔다 — 덮개는 단축키만 쉬게 했지 Esc 겹이 아니었다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ graph: null as unknown, jsonFetch: vi.fn() }));
vi.mock("../src/components/history/useHistoryGraph", () => ({
  useHistoryGraph: () => ({ graph: fixture.graph, err: null }),
}));
// 가짜는 바깥 경계(jsonFetch)에만 — 덮개가 여닫히는 길(시작 신호·폴링)은 실제 모듈 그대로다.
vi.mock("../src/lib/http", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  jsonFetch: (...args: unknown[]) => fixture.jsonFetch(...args),
}));

import { HistoryBoard } from "../src/components/HistoryBoard";
import { SettingsGroup } from "../src/components/settings/SettingsGroup";
import { UpdateProgressOverlay } from "../src/components/UpdateProgressOverlay";
import { isKeyHandled, markKeyHandled } from "../src/lib/keyHandled";
import { startReleaseUpdate, type ReleaseUpdateStatus } from "../src/lib/releaseUpdate";
import { STORAGE_KEYS } from "../src/lib/storageKeys";
import { useEscapeClose } from "../src/lib/useEscapeClose";
import type { Generation } from "../src/types";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  localStorage.clear();
  window.sessionStorage.clear();
  fixture.jsonFetch.mockReset();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const press = (key: string, target: EventTarget = document.body) => {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  act(() => { target.dispatchEvent(event); });
  return event;
};
const noop = () => {};

/** 위에 뜬 창 하나 — 설정 창(SettingsPanel)·정보 창과 같은 등록(`useEscapeClose(onClose)`). */
function Layer({ onClose }: { onClose: () => void }) {
  useEscapeClose(onClose);
  return null;
}

describe("R7 계보 보드의 Esc", () => {
  const gen = (id: string) => ({ id, prompt: "p", status: "done", created_at: "2026-10-11", shared: false, is_held: false,
    is_final: false, is_mine: true, deleted: false, tags: [], auto_tags: [], assets: [], references: [], comment_count: 0 } as unknown as Generation);
  const onSelectionChange = vi.fn();
  // 그래프는 한 번 만들어 그대로 둔다 — 앱도 다시 받기 전까지 같은 객체다.
  const graph = { nodes: [gen("a"), gen("b")], edges: [{ parent_gen_id: "a", child_gen_id: "b", relation: "derived" }], root_ids: ["a"], focus_id: "a" };
  function Screen({ layer }: { layer?: () => void }) {
    return (
      <>
        <HistoryBoard focusId="a" onPreview={noop} onInfo={noop} onRegenerate={noop} onPublish={noop} onUnpublish={noop}
          onFinalize={noop} onUnfinalize={noop} onSelectionChange={onSelectionChange} />
        {layer && <Layer onClose={layer} />}
      </>
    );
  }
  const mount = (layer?: () => void) => { fixture.graph = graph; onSelectionChange.mockClear(); act(() => root.render(<Screen layer={layer} />)); };
  const node = (id: string) => host.querySelector<HTMLElement>(`.linb-node[data-id="${id}"]`)!;
  // 노드를 누른다(끌지 않고 뗀다) — 보드의 실제 누름 처리로 고른다.
  const pick = (id: string, init: MouseEventInit = {}) => {
    act(() => { node(id).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, ...init })); });
    act(() => { window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); });
  };
  const picked = () => [...host.querySelectorAll<HTMLElement>(".linb-node.sel")].map((el) => el.dataset.id);

  it("고른 노드가 있으면 Esc 가 선택을 푼다 — 그 Esc 는 '쓴 것'이다", () => {
    mount();
    pick("a"); pick("b", { ctrlKey: true });
    expect(picked()).toEqual(["a", "b"]);
    const event = press("Escape");
    expect(picked()).toEqual([]);
    expect(onSelectionChange).toHaveBeenLastCalledWith([]); // 선택 막대(App)도 따라 비워진다
    expect(isKeyHandled(event)).toBe(true); // 같은 키로 다른 뒤 화면 처리가 또 받지 않는다
  });

  it("고른 것이 없으면 Esc 를 쓰지 않는다 — 다른 뒤 화면의 Esc 가 받을 수 있다", () => {
    mount();
    expect(isKeyHandled(press("Escape"))).toBe(false);
  });

  it("글 칸에서 난 Esc 와 이미 쓴 Esc 는 선택을 그대로 둔다", () => {
    mount();
    pick("a");
    const input = document.createElement("input"); document.body.append(input);
    press("Escape", input);
    input.remove();
    expect(picked()).toEqual(["a"]);
    const used = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    markKeyHandled(used); // 안쪽 처리(메뉴·확인 덮개)가 먼저 쓴 Esc
    act(() => { document.body.dispatchEvent(used); });
    expect(picked()).toEqual(["a"]);
  });

  it("위에 창이 떠 있으면 Esc 는 그 창만 닫는다 — 닫힌 뒤의 Esc 가 선택을 푼다", () => {
    const onLayerClose = vi.fn();
    mount(onLayerClose);
    pick("a");
    press("Escape");
    expect(onLayerClose).toHaveBeenCalledTimes(1);
    expect(picked()).toEqual(["a"]);
    act(() => root.render(<Screen />)); // 창이 닫혔다
    press("Escape");
    expect(picked()).toEqual([]);
  });

  // 8회차: 끌기 도우미(lib/windowDrag)가 창을 떠날 때도 끌기를 끝낸다 — 그 끝이 클릭으로 확정되면 안 된다(Codex 설계 검토).
  it.each([
    ["창을 떠남(blur)", () => window.dispatchEvent(new Event("blur"))],
    ["단추를 뗀 채 온 움직임", () => window.dispatchEvent(new MouseEvent("mousemove", { clientX: 1, clientY: 1, buttons: 0 }))],
  ])("노드를 누른 채 mouseup 을 놓친 것은 클릭이 아니다 — 고른 것이 바뀌지 않는다: %s", (_name, lose) => {
    mount();
    pick("a");
    expect(picked()).toEqual(["a"]);
    act(() => { node("b").dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 })); });
    act(() => { lose(); });
    act(() => { window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); }); // 돌아와서 뗀 것도
    expect(picked()).toEqual(["a"]);
  });

  // 9회차: 화면을 미는 중에 보드가 내려가면(탭 이동 등) 창에 건 리스너가 남아, 내려간 뒤에 민 만큼이 단추를 뗄 때 이 카드의 카메라로 저장됐다.
  it("가운데 단추로 화면을 미는 중에 보드가 내려가면, 그 뒤의 움직임·뗌은 저장된 카메라를 바꾸지 않는다", () => {
    mount();
    const stored = () => JSON.stringify(Object.keys(localStorage).sort().map((key) => [key, localStorage.getItem(key)]));
    act(() => {
      host.querySelector<HTMLElement>(".linb-scroll")!
        .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 1, buttons: 4, clientX: 100, clientY: 100 }));
    });
    act(() => { window.dispatchEvent(new MouseEvent("mousemove", { clientX: 160, clientY: 130, buttons: 4 })); });
    act(() => root.unmount());
    const atUnmount = stored();
    expect(atUnmount).toContain('\\"x\\":60'); // 내려가는 순간의 카메라(60, 30)는 저장됐다
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 400, clientY: 400, buttons: 4 }));
    window.dispatchEvent(new MouseEvent("mouseup", { button: 1 }));
    expect(stored()).toBe(atUnmount);
    root = createRoot(host); // afterEach 가 내릴 뿌리
  });

  // 10회차(Codex 검토): 휠 줌의 저장은 0.25초 뒤로 예약된다 — 그 전에 다른 계보로 넘어가면 예약된 저장이 새 카드의 값을 적고
  //  떠난 카드의 마지막 줌은 사라졌다.
  it("휠로 줌한 직후(저장이 예약된 0.25초 안)에 다른 계보로 넘어가도 떠난 카드의 줌이 남는다", () => {
    fixture.graph = graph;
    const board = (focusId: string) => (
      <HistoryBoard focusId={focusId} onPreview={noop} onInfo={noop} onRegenerate={noop} onPublish={noop} onUnpublish={noop}
        onFinalize={noop} onUnfinalize={noop} />
    );
    const views = () => JSON.parse(localStorage.getItem(STORAGE_KEYS.historyView) ?? "{}") as Record<string, { z: number }>;
    act(() => root.render(board("a")));
    act(() => {
      host.querySelector<HTMLElement>(".linb-scroll")!
        .dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -100, clientX: 10, clientY: 10 }));
    });
    expect(views().a).toBeUndefined(); // 저장은 아직 예약만 됐다
    act(() => root.render(board("b"))); // 0.25초가 지나기 전에 다른 계보로
    expect(views().a?.z).toBeCloseTo(1.1);
    act(() => root.render(board("a"))); // 돌아오면 그 줌이다
    expect(host.querySelector<HTMLElement>(".linb-canvas")?.style.transform ?? "").toContain("scale(1.1");
  });

  // 10회차(Codex 검토): 보드는 S 의 단일/더블 가르기(220ms)를 모든 카드가 같이 쓴다 — 앞 카드의 대기 중에 누른 다른 카드의 S 가
  //  버려지고 앞 카드의 확인만 뒤늦게 떴다.
  it("한 카드의 S 를 누르고 곧바로(220ms 안) 다른 카드의 S 를 누르면 나중 카드의 확인이 뜬다", async () => {
    mount();
    const sOf = (id: string) => [...node(id).querySelectorAll<HTMLButtonElement>(".linb-ov-btn")].find((button) => button.textContent === "S")!;
    const confirmOn = () => [...host.querySelectorAll<HTMLElement>(".linb-node")].filter((el) => el.querySelector(".sconfirm")).map((el) => el.dataset.id);
    act(() => { sOf("a").click(); });
    act(() => { sOf("b").click(); });
    expect(confirmOn()).toEqual([]); // 아직 더블클릭을 기다리는 중
    await act(async () => { await new Promise((done) => setTimeout(done, 260)); });
    expect(confirmOn()).toEqual(["b"]);
  });
});

describe("R9 설정 옆 패널의 높이", () => {
  // jsdom 에는 레이아웃이 없다 — 여는 단추의 자리, 패널 내용의 높이(scrollHeight), 패널의 테두리(위아래 1px — offsetHeight 와
  //  clientHeight 의 차)만 흉내 낸다. 패널이 아닌 요소는 jsdom 의 값(0) 그대로다.
  const MARGIN = 8;
  const BORDER = 2;
  let contentHeight = 0;
  let saved: { scrollHeight?: PropertyDescriptor; offsetHeight?: PropertyDescriptor; w: number; h: number };
  const isFlyout = (el: Element) => el.classList.contains("settings-group-flyout");
  beforeEach(() => {
    saved = {
      scrollHeight: Object.getOwnPropertyDescriptor(Element.prototype, "scrollHeight"),
      offsetHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight"),
      w: window.innerWidth, h: window.innerHeight,
    };
    window.innerWidth = 1100; window.innerHeight = 700;
    Object.defineProperty(Element.prototype, "scrollHeight", { configurable: true, get(this: Element) { return isFlyout(this) ? contentHeight : 0; } });
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get(this: Element) { return isFlyout(this) ? BORDER : 0; } });
  });
  afterEach(() => {
    window.innerWidth = saved.w; window.innerHeight = saved.h;
    if (saved.scrollHeight) Object.defineProperty(Element.prototype, "scrollHeight", saved.scrollHeight);
    if (saved.offsetHeight) Object.defineProperty(HTMLElement.prototype, "offsetHeight", saved.offsetHeight);
  });

  function open(triggerTop: number) {
    act(() => root.render(<SettingsGroup title="외부 프로그램"><div>내용</div></SettingsGroup>));
    const trigger = host.querySelector<HTMLButtonElement>(".settings-group-toggle")!;
    trigger.getBoundingClientRect = () => ({ top: triggerTop, bottom: triggerTop + 30, left: 700, right: 1000, width: 300, height: 30, x: 700, y: triggerTop, toJSON: noop });
    act(() => trigger.click());
    return document.querySelector<HTMLElement>(".settings-group-flyout")!;
  }
  const px = (value: string) => parseFloat(value);

  it("높이 한도는 패널이 놓인 자리 아래에 남은 높이다 — 열린 뒤 내용이 늘어도 화면 아래로 나가지 않는다", () => {
    contentHeight = 300;
    const flyout = open(350);
    expect(flyout.style.top).toBe("350px"); // 내용이 들어가니 단추 옆에 그대로 연다
    expect(flyout.style.maxHeight).toBe("342px"); // 700 - 350 - 8
    contentHeight = 500; // 연 뒤에 내용이 는다(설정을 받아 온 뒤) — 자리를 다시 잡는 사건은 없다
    expect(px(flyout.style.top) + px(flyout.style.maxHeight)).toBeLessThanOrEqual(window.innerHeight - MARGIN);
  });

  it("자리를 다시 잡으면(스크롤·창 크기) 늘어난 내용이 다 보이게 위로 올리고 한도도 따라간다", () => {
    contentHeight = 300;
    const flyout = open(350);
    contentHeight = 500;
    act(() => { window.dispatchEvent(new Event("scroll")); });
    expect(flyout.style.top).toBe("190px"); // 700 - (500 + 테두리 2) - 8
    // 다 들어가는 패널에는 스크롤바가 생기지 않는다 — 한도가 패널의 바깥 높이(내용 + 테두리)보다 작지 않다.
    expect(flyout.style.maxHeight).toBe("502px");
    contentHeight = 2000; // 화면보다 긴 내용 — 맨 위에 붙이고 안에서 스크롤한다
    act(() => { window.dispatchEvent(new Event("resize")); });
    expect(flyout.style.top).toBe("8px");
    expect(flyout.style.maxHeight).toBe("684px"); // 700 - 8 - 8
  });
});

describe("R16 업데이트 진행 덮개와 Esc", () => {
  const status = (over: Partial<ReleaseUpdateStatus> = {}): ReleaseUpdateStatus => ({
    state: "downloading", message: "", install_mode: "release", current_version: "2026.10.08-0836", latest_version: "2026.10.11-0300",
    can_update: true, generation_active: 0, comfy_active: 0, resolve_active: 0, active_total: 0, updated_at: "", ...over,
  });
  /** 폴링은 promise 체인이라 act 한 번으로는 화면에 닿지 않는다 — microtask 를 몇 번 흘린다. */
  const settle = async (times = 5) => {
    for (let i = 0; i < times; i += 1) await act(async () => { await Promise.resolve(); });
  };
  const veil = () => document.querySelector(".upd-veil");

  it("덮개가 떠 있는 동안 Esc 는 뒤의 설정 창을 닫지 않는다 — 덮개도 그대로다. 덮개가 걷히면 다시 닫는다", async () => {
    const onSettingsClose = vi.fn();
    // 설정 창이 먼저 떠 있고(거기서 업데이트를 누른다), 덮개는 앱에 늘 마운트돼 있다.
    act(() => root.render(<><Layer onClose={onSettingsClose} /><UpdateProgressOverlay /></>));
    fixture.jsonFetch
      .mockResolvedValueOnce(status()) // start 응답
      .mockResolvedValue(status({ state: "failed", message: "download failed" })); // 이후 폴링 — [닫기] 가 나온다
    await act(async () => { await startReleaseUpdate(); });
    await settle();
    expect(veil()).not.toBeNull();

    press("Escape", document.activeElement ?? document.body);
    expect(onSettingsClose).not.toHaveBeenCalled();
    expect(veil()).not.toBeNull();

    act(() => document.querySelector<HTMLButtonElement>(".upd-close")!.click());
    expect(veil()).toBeNull();
    press("Escape");
    expect(onSettingsClose).toHaveBeenCalledTimes(1);
  });
});
