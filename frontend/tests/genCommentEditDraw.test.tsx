// @vitest-environment jsdom
// 생성물 작은 코멘트 창의 [편집](Jay 11-09) — 어셋과 같이 C = 작은 창, [편집] = 그림 창. 넘길 곳이 있을 때만 단추가 있고, 누르면 쓰던 글을 넘긴다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/api", () => ({
  api: new Proxy({} as Record<string, unknown>, {
    get: (_target, name: string) => {
      if (name === "genComments") return async () => [];
      if (name === "genCommentsCached") return () => undefined;
      return () => new Promise(() => {});
    },
  }),
}));

import { GenCommentPanel } from "../src/components/GenCommentPanel";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); // 떠 있는 창 크기 기억(useFloatingPanel)
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const show = (onEditDraw?: (text: string) => boolean) => act(() => root.render(
  <GenCommentPanel genId="g1" label="운동장" myId="u1" syncTick={0} onClose={() => {}} onChanged={() => {}} onEditDraw={onEditDraw} />,
));
const drawButton = () => document.querySelector<HTMLButtonElement>(".cmt-input .cmt-draw-btn");

describe("생성물 작은 코멘트 창 [편집]", () => {
  it("넘길 곳이 없으면(오디오·그림을 모르는 허브) [편집] 이 없다", () => {
    show();
    expect(drawButton()).toBeNull();
  });

  it("입력칸과 [전송] 사이에 있고, 누르면 쓰던 글을 넘긴 뒤 입력을 비운다", () => {
    const onEditDraw = vi.fn(() => true);
    show(onEditDraw);
    // 입력칸 안 오른쪽 아이콘(시안 C) — 글자 없이 펜·종이비행기, 이름은 aria-label
    expect([...document.querySelectorAll(".cmt-input .cmt-inside button")].map((b) => b.getAttribute("aria-label"))).toEqual(["편집", "전송"]);
    expect(drawButton()!.textContent).toBe("");
    const field = document.querySelector<HTMLInputElement>('.cmt-input input[name="c"]')!;
    field.value = "조개 작게";
    act(() => { drawButton()!.click(); });
    expect(onEditDraw).toHaveBeenCalledWith("조개 작게");
    expect(field.value).toBe("");
  });
});
