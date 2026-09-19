// @vitest-environment jsdom
// 창 안의 확인창이 Esc 를 먼저 소비해야 한다 — 바깥 창의 닫기까지 실행되면 입력하던
// 비밀번호·프로젝트 이름이 사라진다(AdminWindow·ProjectManagerPanel, 2026-09-18).
import { act, useEffect, useState } from "react";
import { flushSync } from "react-dom";
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

// 2026-09-19 브라우저 실측: 페이지를 연 뒤 **처음 연** 관리자 창·설정 창이 Esc 한 번에 안 닫혔다.
// 앱이 먼저 등록한 keydown 리스너(선택 해제)가 같은 Esc 에서 재렌더를 일으키면, 렌더마다 새 onClose 를 받는
// 창의 리스너가 **전달 도중 재구독**되며 그 Esc 를 통째로 놓친다(전달 중 제거된 리스너는 불리지 않는다).
function Win({ onClose }: { onClose: () => void }) {
  useEscapeClose(onClose);
  return null;
}
function Shell({ windowOpen, onClose }: { windowOpen: boolean; onClose: () => void }) {
  const [, bump] = useState(0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") flushSync(() => bump((n) => n + 1)); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return windowOpen ? <Win onClose={() => onClose()} /> : null; // 렌더마다 새 함수 — App 의 onAdminClose 와 같은 꼴
}

it("먼저 등록된 리스너가 같은 Esc 에서 재렌더를 일으켜도 첫 Esc 에 닫힌다", () => {
  const onClose = vi.fn();
  act(() => root.render(<Shell windowOpen={false} onClose={onClose} />)); // 앱 리스너가 먼저 등록된다
  act(() => root.render(<Shell windowOpen onClose={onClose} />)); // 창은 나중에 열린다
  pressEscape();
  expect(onClose).toHaveBeenCalledTimes(1);
});
