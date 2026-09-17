// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ResizableSidebar } from "../src/components/common/ResizableSidebar";
import { setLang } from "../src/lib/i18n";

let root: Root, host: HTMLDivElement;
const key = "ch.sidebarWidth";
beforeEach(() => {
  localStorage.clear(); setLang("en");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("innerWidth", 1200);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); setLang("ko"); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function render() {
  act(() => root.render(<StrictMode><ResizableSidebar><button>Folder</button></ResizableSidebar></StrictMode>));
  const handle = host.querySelector<HTMLElement>('[role="separator"]')!;
  let captured: number | null = null;
  handle.setPointerCapture = vi.fn(id => { captured = id; });
  handle.hasPointerCapture = vi.fn(id => captured === id);
  handle.releasePointerCapture = vi.fn(() => { captured = null; });
  return handle;
}
function pointer(handle: HTMLElement, type: string, x: number, id = 1, button = 0, primary = true) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, button });
  Object.defineProperties(event, { pointerId: { value: id }, isPrimary: { value: primary } });
  act(() => { handle.dispatchEvent(event); });
}
function keyboard(handle: HTMLElement, key: string) {
  act(() => { handle.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
}
const width = () => host.querySelector<HTMLElement>("aside")!.style.getPropertyValue("--sidebar-w");

it.each([null, '"320"', "null", "{}", "broken", "1e999"])("잘못된 저장값 %s는 기본 200px", saved => {
  if (saved !== null) localStorage.setItem(key, saved);
  const handle = render(); expect(width()).toBe("200px");
  expect(handle.getAttribute("aria-valuenow")).toBe("200");
  expect(handle.getAttribute("aria-label")).toBe("Resize sidebar");
  act(() => setLang("ko")); expect(handle.getAttribute("aria-label")).toBe("사이드바 너비 조절");
});
it.each([[320, "320px"], [100, "200px"], [800, "480px"]])("저장 폭 %s를 복원/보정한다", (saved, expected) => {
  localStorage.setItem(key, JSON.stringify(saved)); render(); expect(width()).toBe(expected);
});
it("드래그는 경계만 잡고 이동 중 저장 없이 끝날 때 한 번 저장한다", () => {
  const handle = render(); const save = vi.spyOn(Storage.prototype, "setItem");
  pointer(handle, "pointerdown", 200); expect(handle.setPointerCapture).toHaveBeenCalledWith(1);
  pointer(handle, "pointermove", 348); expect(width()).toBe("348px");
  expect(handle.getAttribute("aria-valuenow")).toBe("348"); expect(save).not.toHaveBeenCalled();
  pointer(handle, "pointerup", 348); expect(localStorage.getItem(key)).toBe("348"); expect(save).toHaveBeenCalledTimes(1);
  expect(handle.releasePointerCapture).toHaveBeenCalledWith(1); expect(handle.classList.contains("resizing")).toBe(false);
  act(() => root.render(null)); render(); expect(width()).toBe("348px");
});
it("최소/최대 폭과 다른 포인터·우클릭·추가 터치 제외", () => {
  const handle = render();
  pointer(handle, "pointerdown", 200, 1, 2); pointer(handle, "pointermove", 400); expect(width()).toBe("200px");
  pointer(handle, "pointerdown", 200, 1, 0, false); pointer(handle, "pointermove", 400); expect(width()).toBe("200px");
  pointer(handle, "pointerdown", 200); pointer(handle, "pointermove", 400, 2); pointer(handle, "pointerup", 400, 2);
  expect(width()).toBe("200px");
  pointer(handle, "pointermove", 2000); expect(width()).toBe("480px");
  pointer(handle, "pointermove", -100); expect(width()).toBe("200px"); pointer(handle, "pointerup", -100);
  expect(localStorage.getItem(key)).toBeNull();
});
it.each(["pointercancel", "lostpointercapture", "blur", "Escape"])("%s는 이전 폭 복원·미저장·조절 종료", type => {
  localStorage.setItem(key, "300"); const handle = render();
  pointer(handle, "pointerdown", 300); pointer(handle, "pointermove", 430);
  if (type === "blur") act(() => { window.dispatchEvent(new Event("blur")); });
  else if (type === "Escape") keyboard(handle, type);
  else pointer(handle, type, 430);
  expect(width()).toBe("300px"); expect(localStorage.getItem(key)).toBe("300");
  pointer(handle, "pointermove", 460); expect(width()).toBe("300px");
  expect(handle.classList.contains("resizing")).toBe(false);
});
it("창을 줄일 때 표시만 보정하고 다시 넓히면 저장된 선호폭을 복원한다", () => {
  localStorage.setItem(key, "460"); const handle = render();
  vi.stubGlobal("innerWidth", 600); act(() => { window.dispatchEvent(new Event("resize")); });
  expect(width()).toBe("300px"); expect(handle.getAttribute("aria-valuemax")).toBe("300");
  pointer(handle, "pointerdown", 300); pointer(handle, "pointerup", 300); // 클릭만 하면 선호폭을 덮지 않음.
  expect(localStorage.getItem(key)).toBe("460");
  vi.stubGlobal("innerWidth", 1200); act(() => { window.dispatchEvent(new Event("resize")); });
  expect(width()).toBe("460px");
});
it("키보드 조절과 더블클릭 복원은 저장하며 전역 단축키에 전달하지 않는다", () => {
  const handle = render(); const globalKey = vi.fn(); window.addEventListener("keydown", globalKey);
  try {
    keyboard(handle, "ArrowRight"); expect(width()).toBe("208px");
    keyboard(handle, "ArrowLeft"); expect(width()).toBe("200px");
    keyboard(handle, "End"); expect(width()).toBe("480px");
    keyboard(handle, "Home"); expect(width()).toBe("200px");
    keyboard(handle, "End");
    act(() => { handle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
    expect(width()).toBe("200px"); expect(localStorage.getItem(key)).toBe("200"); expect(globalKey).not.toHaveBeenCalled();
  } finally { window.removeEventListener("keydown", globalKey); }
});
it("드래그 중 언마운트는 저장하지 않고 창 리스너도 정리한다", () => {
  localStorage.setItem(key, "300"); const handle = render(); const remove = vi.spyOn(window, "removeEventListener");
  pointer(handle, "pointerdown", 300); pointer(handle, "pointermove", 420); act(() => root.render(null));
  expect(localStorage.getItem(key)).toBe("300");
  expect(remove).toHaveBeenCalledWith("resize", expect.any(Function)); expect(remove).toHaveBeenCalledWith("blur", expect.any(Function));
  render(); expect(width()).toBe("300px");
});
it("조절 중이 아닐 때 Esc는 기존 카드/캔버스 취소 기능에 전달한다", () => {
  const handle = render(); const globalKey = vi.fn(); window.addEventListener("keydown", globalKey);
  try {
    keyboard(handle, "Escape"); expect(globalKey).toHaveBeenCalledTimes(1);
    pointer(handle, "pointerdown", 200); pointer(handle, "pointermove", 320);
    keyboard(handle, "Escape"); expect(globalKey).toHaveBeenCalledTimes(1); expect(width()).toBe("200px");
  } finally { window.removeEventListener("keydown", globalKey); }
});
it("저장소 차단 시에도 키보드와 드래그로 화면 폭을 바꿀 수 있다", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
  const handle = render(); keyboard(handle, "ArrowRight"); expect(width()).toBe("208px");
  pointer(handle, "pointerdown", 208); pointer(handle, "pointermove", 360); pointer(handle, "pointerup", 360);
  expect(width()).toBe("360px");
});
