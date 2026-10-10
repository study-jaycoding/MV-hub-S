// @vitest-environment jsdom
// 분리 창(관리·Assets)은 App 밖에서 따로 뜬다(main.tsx) — 앱이 한 번 거는 키 지킴이(조합 중 Enter·입력칸 밖 Ctrl+A)가
// 이 창들에도 걸려 있어야 한다. 빠지면 한글을 치다 누른 Enter 가 덜 친 글자로 저장된다(작업표 설명칸 등).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../src/api", () => ({ api: { authConfig: () => new Promise(() => {}), workspaceOptions: () => new Promise(() => {}) } }));
vi.mock("../src/lib/useManageCaps", () => ({ useManageCaps: () => ({ loaded: false }) }));
vi.mock("../src/lib/useManageRealtime", () => ({ useManageRealtime: () => 0 }));
vi.mock("../src/components/manage/DashboardView", () => ({ DashboardView: () => null }));
vi.mock("../src/components/manage/ExportView", () => ({ ExportView: () => null }));
vi.mock("../src/components/manage/WorkBoard", () => ({ WorkBoard: () => null }));
vi.mock("../src/components/AssetsView", () => ({ AssetsView: () => null }));
vi.mock("../src/components/InfoPopup", () => ({ InfoPopup: () => null }));
vi.mock("../src/components/MediaPreview", () => ({ MediaPreview: () => null }));

import { AssetsWindow } from "../src/components/AssetsWindow";
import { ManageWindow } from "../src/components/ManageWindow";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

it.each([
  ["관리 창", () => <ManageWindow />],
  ["Assets 창", () => <AssetsWindow />],
])("%s — 조합 중의 Enter 는 입력칸의 키 처리에 닿지 않고, 확정 뒤의 Enter 는 닿는다", (_name, view) => {
  act(() => root.render(view()));
  const input = document.createElement("input");
  host.append(input);
  const seen = vi.fn();
  input.addEventListener("keydown", (event) => { if (event.key === "Enter") seen(); });
  const composing = new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true });
  input.dispatchEvent(composing);
  expect(seen).not.toHaveBeenCalled();
  expect(composing.defaultPrevented).toBe(false); // 조합 확정(브라우저의 기본 동작)은 그대로
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  expect(seen).toHaveBeenCalledTimes(1);
});

it.each([
  ["관리 창", () => <ManageWindow />],
  ["Assets 창", () => <AssetsWindow />],
])("%s — 입력칸 밖의 Ctrl+A 는 화면 글자를 긁지 않는다", (_name, view) => {
  act(() => root.render(view()));
  const outside = new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true });
  document.body.dispatchEvent(outside);
  expect(outside.defaultPrevented).toBe(true);
});
