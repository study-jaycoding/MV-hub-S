// @vitest-environment jsdom
// Assets 분리 창 — 60회차(Codex): 색·태그·코멘트 저장 실패 안내(ch:flash)를 받아 그릴 자리가 이 창에 없어, 분리 창에서는 실패를 모른 채 지나갔다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../src/components/AssetsView", () => ({ AssetsView: () => null }));
vi.mock("../src/components/InfoPopup", () => ({ InfoPopup: () => null }));
vi.mock("../src/components/MediaPreview", () => ({ MediaPreview: () => null }));

import { AssetsWindow } from "../src/components/AssetsWindow";
import { flashMsg } from "../src/lib/flash";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it("분리 창도 실패 안내를 보인다", () => {
  act(() => root.render(<AssetsWindow />));
  act(() => flashMsg("색을 저장하지 못했습니다"));
  expect(host.querySelector(".toast")?.textContent).toBe("색을 저장하지 못했습니다"); // 전엔 받을 곳이 없어 아무것도 안 떴다
});
