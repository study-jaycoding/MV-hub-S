// @vitest-environment jsdom
// 선택이 비어 있을 때의 선택 해제는 재렌더를 일으키지 않아야 한다.
// Esc 마다 App 전체가 다시 그려지면, 같은 Esc 를 기다리던 다른 keydown 리스너가 전달 도중 재구독되며 첫 입력을 놓친다
// (2026-09-19 브라우저 실측: 처음 연 관리자 창·설정 창이 Esc 한 번에 안 닫힘 — useEscapeClose 와 한 쌍의 원인).
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useGenerationSelection } from "../src/lib/useGenerationSelection";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it("빈 선택에서 clearSelect 는 커밋(효과 재실행)을 일으키지 않고, 선택이 있으면 비운다", () => {
  // ★렌더 함수 호출 수가 아니라 **커밋 수**를 센다. 같은 상태를 돌려주면 React 는 함수를 한 번 더 부를 수는 있어도
  //  커밋하지 않는다 — 리스너 재구독을 일으키는 것은 효과의 재실행(커밋)이다.
  let commits = 0;
  let api!: ReturnType<typeof useGenerationSelection>;
  function Probe() {
    api = useGenerationSelection({ resetKey: "k" });
    useEffect(() => { commits += 1; });
    return null;
  }
  act(() => root.render(<Probe />));
  const settled = commits; // 마운트 뒤의 resetKey 효과까지 끝난 횟수

  act(() => api.clearSelect());
  expect(commits).toBe(settled);

  act(() => api.toggleSelect("a"));
  expect(api.selected.has("a")).toBe(true);
  act(() => api.clearSelect());
  expect(api.selected.size).toBe(0);
});
