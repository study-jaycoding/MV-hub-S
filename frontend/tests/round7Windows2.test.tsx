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
