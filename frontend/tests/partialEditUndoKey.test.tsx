// @vitest-environment jsdom
// 부분 수정 창의 그리기 단계 — Ctrl+Z 는 한 획을 지우고, 다시 하기(Ctrl+Shift+Z·Ctrl+Y)는 지운 획을 되살린다(조작 규칙 44).
// 2026-10-12 조작 점검 17회차(Codex 전수 검토): Shift 를 가리지 않아, 지운 획을 다시 하려던 Ctrl+Shift+Z 가 남은 획까지 하나 더 지웠다.
// 2026-10-28 수정 창 개편: 다시 하기가 생겼다 — 이제 Ctrl+Shift+Z 는 획을 되살린다(지우지 않는 것은 그대로).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// 가짜는 바깥 경계에만 — 서버 응답은 '아직 안 옴', 원본 그림은 받은 것으로.
vi.mock("../src/api", () => {
  const pending = () => new Promise(() => {});
  return { api: new Proxy({} as Record<string, unknown>, { get: (target, name: string) => target[name] ?? pending }) };
});
vi.mock("../src/lib/download", () => ({ fetchBlob: vi.fn(async () => new Blob(["x"], { type: "image/png" })) }));

import { PartialEditModal } from "../src/components/edit/PartialEditModal";
import type { Generation } from "../src/types";
import { unloadHeld, unsavedPlaces } from "../src/lib/unloadGuard";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 100, height: 100, close: () => {} }))); // jsdom 에는 그림 해석이 없다
  URL.createObjectURL = vi.fn(() => "blob:fixture");
  URL.revokeObjectURL = vi.fn();
  // jsdom 에는 캔버스 그리기·포인터 쥐기가 없다 — 그리기는 건너뛰고(획의 목록만 본다) 쥐기는 빈 함수로
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  Element.prototype.setPointerCapture = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}) });
  localStorage.clear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const settle = () => act(async () => { for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); });
const gen = { id: "g", status: "done", prompt: "p", assets: [{ id: "a", generation_id: "g", type: "image", file_path: "/g.png" }] } as unknown as Generation;
const canvas = () => document.querySelector<HTMLCanvasElement>(".partial-edit-stagebox canvas")!;
const pointer = (type: string, x: number, y: number) => act(() => {
  canvas().dispatchEvent(Object.assign(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }), { pointerId: 1 }));
});
/** 펜으로 한 획 긋는다. */
const stroke = (x: number) => { pointer("pointerdown", x, 10); pointer("pointermove", x + 20, 30); pointer("pointerup", x + 20, 30); };
const key = (init: KeyboardEventInit) => {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  act(() => { document.body.dispatchEvent(event); });
  return event;
};
const clearButton = () => document.querySelector<HTMLButtonElement>('.pe-dock button[aria-label="전체 지우기"]')!;

// 56회차 — 그린 획·친 프롬프트는 이 창의 상태에만 있다. 그동안 창을 닫거나 새로고침하면 브라우저가 묻는다(전엔 편집 탭만 물었다).
it("그린 것이 있는 동안만 나갈 때 묻는다 — 다 지우거나 창을 닫으면 묻지 않는다", async () => {
  act(() => root.render(<PartialEditModal gen={gen} workspace={{ scope: "personal", id: null, name: null } as never} onQueued={() => {}} onClose={() => {}} />));
  await settle();
  expect(unloadHeld()).toBe(false);
  stroke(10);
  expect(unsavedPlaces()).toBe("부분 수정 창");
  act(() => clearButton().click());
  expect(unloadHeld()).toBe(false);
  stroke(10);
  act(() => root.render(<></>)); // 창을 닫는다
  expect(unloadHeld()).toBe(false);
});

it("그리기 — Ctrl+Z 는 한 획을 지우고, 다시 하기(Ctrl+Shift+Z)는 그 획을 되살린다. 둘 다 뒤 화면으로 흘리지 않는다", async () => {
  act(() => root.render(<PartialEditModal gen={gen} workspace={{ scope: "personal", id: null, name: null } as never} onQueued={() => {}} onClose={() => {}} />));
  await settle();
  expect(canvas(), "그리기 단계").toBeTruthy();
  const undoButton = () => document.querySelector<HTMLButtonElement>('.pe-dock button[aria-label="되돌리기"]')!;
  const redoButton = () => document.querySelector<HTMLButtonElement>('.pe-dock button[aria-label="다시"]')!;
  expect(clearButton().disabled).toBe(true); // 아직 그린 것이 없다
  stroke(10);
  stroke(50);
  expect(clearButton().disabled).toBe(false);
  key({ key: "z", code: "KeyZ", ctrlKey: true }); // 한 획 지움 — 하나 남는다
  expect(clearButton().disabled).toBe(false);
  expect(redoButton().disabled).toBe(false); // 되살릴 획이 하나 있다
  const behind = vi.fn();
  window.addEventListener("keydown", behind); // 뒤 캔버스의 단축키 자리(window 의 오르는 단계)
  try {
    const redo = key({ key: "Z", code: "KeyZ", ctrlKey: true, shiftKey: true });
    expect(redoButton().disabled).toBe(true); // 되살렸다 — 두 획
    expect(redo.defaultPrevented).toBe(true);
    expect(behind).not.toHaveBeenCalled(); // 뒤 화면의 다시 하기가 돌지 않는다
  } finally {
    window.removeEventListener("keydown", behind);
  }
  key({ key: "z", code: "KeyZ", ctrlKey: true });
  key({ key: "z", code: "KeyZ", ctrlKey: true }); // 두 획 다 지운다(전엔 다시 하기가 한 획을 더 지워 여기서 하나만 남았다)
  expect(clearButton().disabled).toBe(true);
  expect(undoButton().disabled).toBe(true);
  key({ key: "y", code: "KeyY", ctrlKey: true }); // Ctrl+Y 도 다시 하기
  expect(clearButton().disabled).toBe(false);
});
