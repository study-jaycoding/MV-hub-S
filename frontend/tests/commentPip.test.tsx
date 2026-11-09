// @vitest-environment jsdom
// 코멘트 창 '창 밖으로'(Jay 2026-11-10) — 크롬 떠 있는 작은 창(Document Picture-in-Picture)에 같은 부품을 옮겨 그린다.
//  계약: 지원하는 화면에만 단추 · 옮길 때 쓰던 글이 따라감 · 대상이 바뀌면 그 창에서 바뀜 · [앱 안으로]·창 닫기 = 앱 안으로(다음에도 앱 안)
//  · 패널 ✕ = 창째 닫고 '띄워서 보기' 기억 · 같은 묶음의 새 패널(Assets 파일 전환)은 창을 이어받는다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CommentPanel, type CommentPanelItem } from "../src/components/common/CommentPanel";

let host: HTMLDivElement;
let root: Root;
let pipDoc: Document;
let pipWin: { document: Document; closed: boolean; close: ReturnType<typeof vi.fn>; addEventListener: (type: string, fn: () => void) => void; hide: () => void };
let requestWindow: ReturnType<typeof vi.fn>;

function installPip() {
  requestWindow = vi.fn(async () => {
    pipDoc = document.implementation.createHTMLDocument("pip");
    const hides: (() => void)[] = [];
    pipWin = {
      document: pipDoc, closed: false,
      close: vi.fn(() => { pipWin.closed = true; hides.forEach((fn) => fn()); }),
      addEventListener: (type, fn) => { if (type === "pagehide") hides.push(fn); },
      hide: () => hides.forEach((fn) => fn()), // 사용자가 띄운 창의 ✕ 를 눌렀다
    };
    return pipWin;
  });
  Object.defineProperty(window, "documentPictureInPicture", { value: { requestWindow }, configurable: true });
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
  localStorage.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  act(() => root.unmount());
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); // 예약된 닫기
  host.remove();
  delete (window as unknown as Record<string, unknown>).documentPictureInPicture;
});

const item = (id: string, text: string): CommentPanelItem => ({ id, author: "me", author_name: "나", text, created_at: "2026-11-10 08:00:00", parent_id: null });
function show(comments: CommentPanelItem[], extra: { pipId?: string; embedded?: boolean; key?: string; onClose?: () => void } = {}) {
  act(() => root.render(<CommentPanel key={extra.key ?? "p"} comments={comments} label="생성물" myId="me" panelRef={() => {}} pos={{ x: 0, y: 0 }}
    onHeadMouseDown={() => {}} onClose={extra.onClose ?? (() => {})} onSend={async () => true} onEdit={async () => true} onDelete={() => {}}
    pipId={"pipId" in extra ? extra.pipId : "gen"} embedded={extra.embedded} />));
}
const popBtn = (doc: Document | HTMLElement) => doc.querySelector<HTMLButtonElement>(".cmt-pip-btn");
function type(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("shows [창 밖으로] only where Chrome can open the floating window, and never in the draw window's embedded list", () => {
  show([]);
  expect(popBtn(host)).toBeNull(); // 크롬 기능이 없다(다른 브라우저)
  act(() => root.unmount());
  root = createRoot(host);
  installPip();
  Object.defineProperty(window, "isSecureContext", { value: false, configurable: true });
  show([]);
  expect(popBtn(host)).toBeNull(); // 서버 주소 직결(LAN http) — 안전하지 않은 주소
  Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
  show([], { key: "q" });
  expect(popBtn(host)?.getAttribute("aria-label")).toBe("창 밖으로");
  show([], { key: "r", embedded: true, pipId: undefined });
  expect(popBtn(host)).toBeNull();
});

it("pops out with the app's styles and the typed text, follows the next target, and comes back in with the text", async () => {
  installPip();
  const style = document.createElement("style");
  style.textContent = ".cmt-panel { color: rgb(1, 2, 3); }";
  document.head.append(style);
  show([item("a", "모자 색")]);
  type(host.querySelector<HTMLInputElement>('.cmt-input input[name="c"]')!, "빨간 모자로");
  await act(async () => { popBtn(host)!.click(); });
  expect(requestWindow).toHaveBeenCalledWith({ width: 644, height: 380 });
  expect(host.querySelector(".cmt-panel")).toBeNull(); // 앱 안에서는 사라지고
  const floating = pipDoc.body.querySelector(".cmt-panel.cmt-pip")!;
  expect(floating).not.toBeNull(); // 떠 있는 창에 그린다
  expect([...pipDoc.head.querySelectorAll("style")].some((s) => s.textContent?.includes("rgb(1, 2, 3)"))).toBe(true); // 앱 스타일을 옮겼다
  expect(floating.querySelector<HTMLInputElement>('input[name="c"]')!.value).toBe("빨간 모자로"); // 쓰던 글이 따라왔다
  expect(localStorage.getItem("ch.cmt.pip")).toBe("1");
  show([item("b", "다른 카드의 코멘트")]); // 다른 카드의 C — 같은 패널이 따라간다
  expect(pipDoc.body.textContent).toContain("다른 카드의 코멘트");
  const back = popBtn(pipDoc.body)!;
  expect(back.getAttribute("aria-label")).toBe("앱 안으로");
  await act(async () => { back.click(); });
  expect(pipWin.close).toHaveBeenCalled();
  expect(host.querySelector<HTMLInputElement>('.cmt-input input[name="c"]')!.value).toBe("빨간 모자로"); // 다시 따라왔다
  expect(localStorage.getItem("ch.cmt.pip")).toBe("0"); // 다음에도 앱 안
  style.remove();
});

it("closing the floating window itself brings the panel back into the app", async () => {
  installPip();
  show([item("a", "모자 색")]);
  await act(async () => { popBtn(host)!.click(); });
  expect(pipDoc.body.querySelector(".cmt-panel")).not.toBeNull();
  act(() => pipWin.hide()); // 띄운 창의 ✕
  expect(host.querySelector(".cmt-panel")).not.toBeNull();
  expect(localStorage.getItem("ch.cmt.pip")).toBe("0");
});

it("a new panel of the same group keeps the floating window (Assets file switch); the panel ✕ closes it but next time opens floating again", async () => {
  installPip();
  show([item("a", "a.png 코멘트")], { key: "a.png" });
  await act(async () => { popBtn(host)!.click(); });
  const first = pipWin;
  show([item("b", "b.png 코멘트")], { key: "b.png" }); // Assets 는 파일마다 패널을 새로 만든다
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(first.close).not.toHaveBeenCalled(); // 닫지 않고 이어받았다
  expect(pipDoc.body.textContent).toContain("b.png 코멘트");
  act(() => root.unmount()); // 코멘트 창 ✕
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(first.close).toHaveBeenCalled();
  expect(localStorage.getItem("ch.cmt.pip")).toBe("1"); // 띄워서 보기는 기억한다
  root = createRoot(host);
  await act(async () => { show([item("c", "c.png")], { key: "c.png" }); });
  expect(requestWindow).toHaveBeenCalledTimes(2); // 다시 열면 바로 띄운다(누름이 있을 때 크롬이 받는다)
});
