// @vitest-environment jsdom
// 조작 점검 7회차(2026-10-11) — R19 비교 창의 push 단추(누르고 있는 동안만 2번을 보인다)를 키보드로 누를 수 없었다.
//  포인터 처리만 있었고, 창이 window 의 잡는 단계에서 단추에서 난 키까지 멈춰 단추에 닿지도 않았다.
//  두 창(버전 비교 · 미디어 비교)이 같은 단추를 따로 갖고 있어 같은 시험을 둘 다에 돌린다.
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 모델 이름 카탈로그는 서버에서 받는다 — 이 시험과 무관해 받지 않게만 한다.
vi.mock("../src/lib/modelCatalog", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useModelDisplayName: () => (code?: string | null) => code ?? "",
}));

import { CompareModal } from "../src/components/CompareModal";
import { VideoCompareModal } from "../src/components/VideoCompareModal";
import { useEscapeClose } from "../src/lib/useEscapeClose";
import type { Generation } from "../src/types";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const image = (id: string) => ({ id, prompt: "p " + id, status: "done", created_at: "2026-10-11", model: "m", params: {},
  shared: false, is_held: false, is_final: false, is_mine: true, deleted: false, tags: [], auto_tags: [], references: [], comment_count: 0,
  assets: [{ id: "as-" + id, type: "image", file_path: `/media/${id}.png`, thumbnail_path: `/media/${id}_t.png` }] } as unknown as Generation);

const windows: [string, (onClose: () => void) => ReactElement][] = [
  ["버전 비교(CompareModal)", (onClose) => <CompareModal gens={[image("a"), image("b")]} onClose={onClose} />],
  ["미디어 비교(VideoCompareModal)", (onClose) => (
    <VideoCompareModal onClose={onClose}
      videos={[{ url: "/media/a.png", name: "a", type: "image" }, { url: "/media/b.png", name: "b", type: "image" }]} />
  )],
];

describe.each(windows)("R19 %s 의 push 단추", (_name, render) => {
  const onClose = vi.fn();
  /** 창을 띄우고 '이미지 비교'를 켠다 → push 단추와 그 옆 A/B 단추. */
  function open() {
    onClose.mockClear();
    act(() => root.render(render(onClose)));
    const toggle = [...host.querySelectorAll("label")].find((label) => label.textContent?.includes("이미지 비교"))!.querySelector("input")!;
    act(() => toggle.click());
    const [push, ab] = [...host.querySelectorAll<HTMLButtonElement>(".cmp-abbtns button")];
    act(() => push.focus()); // Tab 으로 단추에 왔다
    return { push, ab };
  }
  const key = (type: "keydown" | "keyup", k: string, target: EventTarget) => {
    const event = new KeyboardEvent(type, { key: k, bubbles: true, cancelable: true });
    act(() => { target.dispatchEvent(event); });
    return event;
  };
  const shown = () => host.querySelector(".cmp-ablabel")?.textContent;

  it.each([[" ", "Space"], ["Enter", "Enter"]])("%s(%s)를 누르고 있는 동안만 2번을 보인다 — 떼면 돌아온다", (k) => {
    const { push } = open();
    expect(shown()).toBe("A 1번");
    key("keydown", k, push);
    expect(shown()).toBe("B 2번");
    expect(push.className).toBe("on");
    key("keydown", k, push); // 누르고 있으면 반복 입력이 온다 — 그대로다
    expect(shown()).toBe("B 2번");
    key("keyup", k, push);
    expect(shown()).toBe("A 1번");
  });

  it("누른 채 초점이 단추를 떠나면 끝난다 — 뗌을 놓쳐 2번에 붙지 않는다", () => {
    const { push, ab } = open();
    key("keydown", " ", push);
    expect(shown()).toBe("B 2번");
    act(() => ab.focus());
    expect(shown()).toBe("A 1번");
  });

  it("push 의 누름 키는 뒤 화면으로 새지 않고, 그 밖의 키는 전처럼 창이 막는다", () => {
    const { push, ab } = open();
    const behind = vi.fn(); // 뒤 화면의 키 처리(window, 버블)
    window.addEventListener("keydown", behind);
    try {
      key("keydown", " ", push);
      key("keydown", "Enter", push);
      key("keydown", "Delete", push); // push 단추에서 났어도 누름 키가 아니면 막는다
      key("keydown", " ", ab); // 다른 단추의 키
      key("keydown", "Delete", document.body);
      expect(behind).not.toHaveBeenCalled();
      expect(shown()).toBe("B 2번"); // 앞의 Space·Enter 로 눌린 채다 — Delete·다른 단추의 키는 push 를 건드리지 않는다
    } finally {
      window.removeEventListener("keydown", behind);
    }
  });

  it("다른 키로는 눌리지 않고, Esc 는 전처럼 창을 닫는다", () => {
    const { push } = open();
    key("keydown", "a", push);
    key("keydown", "ArrowRight", push);
    expect(shown()).toBe("A 1번");
    key("keydown", "Escape", push);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("위에 다른 창이 떠 있을 때 단추에서 난 Esc 는 그 창의 것이다 — push 가 가로채지 않는다", () => {
    const onUpperClose = vi.fn();
    onClose.mockClear();
    // 비교 창보다 나중에 뜬 겹(확인 창 등 — 버블 단계에서 듣는다). 창의 가로채기는 Esc 를 막지 않아 단추까지 온다.
    act(() => root.render(<>{render(onClose)}<Upper onClose={onUpperClose} /></>));
    const toggle = [...host.querySelectorAll("label")].find((label) => label.textContent?.includes("이미지 비교"))!.querySelector("input")!;
    act(() => toggle.click());
    const push = host.querySelector<HTMLButtonElement>(".cmp-abbtns button")!;
    key("keydown", "Escape", push);
    expect(onUpperClose).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(shown()).toBe("A 1번");
  });
});

function Upper({ onClose }: { onClose: () => void }) {
  useEscapeClose(onClose);
  return null;
}

// 8회차(2026-10-11 격리 실측 dist_b46): 버전 비교 창의 이동·크기 조절이 mouseup 을 놓치면 단추를 뗀 마우스를 계속 따라왔다(각 3/3, blur 뒤에도).
describe("버전 비교 창의 이동·크기 조절 — 놓친 mouseup", () => {
  const box = () => {
    const style = host.querySelector<HTMLElement>(".cmp-window")!.style;
    return [style.left, style.top, style.width, style.height];
  };
  const pointer = (type: string, target: EventTarget, init: MouseEventInit) =>
    act(() => { target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init })); });
  function open() {
    Object.assign(window, { innerWidth: 1600, innerHeight: 900 });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      { left: 200, top: 100, right: 1000, bottom: 600, width: 800, height: 500, x: 200, y: 100, toJSON: () => ({}) } as DOMRect);
    act(() => root.render(<CompareModal gens={[image("a"), image("b")]} onClose={() => {}} />));
  }
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["단추를 뗀 채 온 움직임", () => window.dispatchEvent(new MouseEvent("pointermove", { clientX: 700, clientY: 500, buttons: 0 }))],
    ["창을 떠남(blur)", () => window.dispatchEvent(new Event("blur"))],
  ])("머리를 끌다 놓치면 그 자리에 멈춘다 — %s", (_name, lose) => {
    open();
    pointer("pointerdown", host.querySelector(".cmp-window .admin-head")!, { clientX: 300, clientY: 120 });
    pointer("pointermove", window, { clientX: 350, clientY: 150, buttons: 1 });
    const kept = box();
    expect(kept.slice(0, 2)).toEqual(["250px", "130px"]);
    act(() => { lose(); });
    pointer("pointermove", window, { clientX: 520, clientY: 320, buttons: 1 }); // 곧바로 다른 것을 누른 채 움직여도(끝나 있다)
    expect(box()).toEqual(kept);
    pointer("pointermove", window, { clientX: 500, clientY: 300, buttons: 0 });
    expect(box()).toEqual(kept);
  });

  it("다른 포인터의 up·cancel·단추 없는 움직임은 이 끌기를 끝내지 않는다 — 잡은 포인터가 끝나거나 창을 떠나면 끝난다", () => {
    open();
    // jsdom 의 MouseEvent 에는 pointerId 가 없다 — 붙여서 쏜다
    const withId = (type: string, pointerId: number, init: MouseEventInit) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init });
      Object.defineProperty(event, "pointerId", { value: pointerId });
      return event;
    };
    const fire = (target: EventTarget, event: Event) => act(() => { target.dispatchEvent(event); });
    fire(host.querySelector(".cmp-window .admin-head")!, withId("pointerdown", 1, { clientX: 300, clientY: 120 }));
    fire(window, withId("pointermove", 1, { clientX: 350, clientY: 150, buttons: 1 }));
    expect(box().slice(0, 2)).toEqual(["250px", "130px"]);
    fire(window, withId("pointerup", 2, {}));
    fire(window, withId("pointercancel", 2, {}));
    fire(window, withId("pointermove", 1, { clientX: 400, clientY: 180, buttons: 1 }));
    expect(box().slice(0, 2)).toEqual(["300px", "160px"]); // 여전히 끌린다
    fire(window, withId("pointerup", 1, {}));
    fire(window, withId("pointermove", 1, { clientX: 600, clientY: 400, buttons: 1 }));
    expect(box().slice(0, 2)).toEqual(["300px", "160px"]);
  });

  it("크기 손잡이를 끌다 놓쳐도 뗀 마우스를 따라 커지지 않는다 · 정상으로 놓으면 그 크기", () => {
    open();
    const handle = host.querySelector<HTMLElement>(".cmp-window-resize")!;
    pointer("pointerdown", handle, { clientX: 1000, clientY: 600 });
    pointer("pointermove", window, { clientX: 950, clientY: 570, buttons: 1 });
    const kept = box();
    expect(kept.slice(2)).toEqual(["750px", "470px"]);
    pointer("pointermove", window, { clientX: 800, clientY: 400, buttons: 0 }); // mouseup 을 놓쳤다
    pointer("pointermove", window, { clientX: 700, clientY: 300, buttons: 0 });
    expect(box()).toEqual(kept);
    pointer("pointerdown", handle, { clientX: 1000, clientY: 600 }); // 다시 잡아 정상으로 놓는다
    pointer("pointermove", window, { clientX: 1100, clientY: 650, buttons: 1 });
    pointer("pointerup", window, { clientX: 1100, clientY: 650 });
    pointer("pointermove", window, { clientX: 1300, clientY: 800, buttons: 1 });
    expect(box().slice(2)).toEqual(["900px", "550px"]);
  });
});
