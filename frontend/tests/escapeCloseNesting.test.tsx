// @vitest-environment jsdom
// 창 안의 확인창이 Esc 를 먼저 소비해야 한다 — 바깥 창의 닫기까지 실행되면 입력하던
// 비밀번호·프로젝트 이름이 사라진다(AdminWindow·ProjectManagerPanel, 2026-09-18).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useEscapeClose } from "../src/lib/useEscapeClose";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

function Inner({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEscapeClose(onClose, open, true, true); // 자식 소유 대화상자: capture + consume
  return null;
}
function Outer({ innerOpen, onInner, onOuter }: { innerOpen: boolean; onInner: () => void; onOuter: () => void }) {
  useEscapeClose(onOuter); // 바깥 창: window bubble
  return <Inner open={innerOpen} onClose={onInner} />;
}
const pressEscape = () =>
  act(() => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });

it("안쪽 창이 열려 있으면 Esc 는 안쪽만 닫고 바깥 창에는 닿지 않는다", () => {
  const onInner = vi.fn(); const onOuter = vi.fn();
  act(() => root.render(<Outer innerOpen onInner={onInner} onOuter={onOuter} />));
  pressEscape();
  expect(onInner).toHaveBeenCalledTimes(1);
  expect(onOuter).not.toHaveBeenCalled();
});

it("안쪽 창이 닫혀 있으면 Esc 는 바깥 창을 닫는다", () => {
  const onInner = vi.fn(); const onOuter = vi.fn();
  act(() => root.render(<Outer innerOpen={false} onInner={onInner} onOuter={onOuter} />));
  pressEscape();
  expect(onInner).not.toHaveBeenCalled();
  expect(onOuter).toHaveBeenCalledTimes(1);
});
