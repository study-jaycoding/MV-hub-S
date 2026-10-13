// @vitest-environment jsdom
// 선택이 비어 있을 때의 선택 해제는 재렌더를 일으키지 않아야 한다.
// Esc 마다 App 전체가 다시 그려지면, 같은 Esc 를 기다리던 다른 keydown 리스너가 전달 도중 재구독되며 첫 입력을 놓친다
// (2026-09-19 브라우저 실측: 처음 연 관리자 창·설정 창이 Esc 한 번에 안 닫힘 — useEscapeClose 와 한 쌍의 원인).
import { act, useEffect } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useGenerationSelection, withoutHidden } from "../src/lib/useGenerationSelection";

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

// 29회차(Jay "검색과 같게"): 보기 필터는 보이는 카드를 고른 채로 두는데, 툴바·검색칸을 마우스로 누르는 순간이 '밖 누름'이라 선택이 먼저 풀렸다
//  (Codex 코드 리뷰 — 28회차의 검색어 변경도 키보드에서만 효과가 있었다).
it("툴바·상단바(검색칸)·태그 패널·사이드바 필터 칸 안의 누름은 선택을 풀지 않는다 — 그 밖의 누름은 전처럼 푼다", () => {
  let api!: ReturnType<typeof useGenerationSelection>;
  function Probe() {
    api = useGenerationSelection({ resetKey: "k" });
    return null;
  }
  act(() => root.render(<Probe />));
  const inside = ["lib-toolbar", "topbar", "tag-panel", "sidebar-foot"].map((cls) => {
    const wrap = document.createElement("div");
    wrap.className = cls;
    const control = document.createElement(cls === "topbar" ? "input" : "button");
    wrap.append(control);
    document.body.append(wrap);
    return control;
  });
  const outside = document.createElement("div");
  document.body.append(outside);
  act(() => api.toggleSelect("g1"));
  for (const control of inside) {
    act(() => control.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect([control.parentElement?.className, api.selected.has("g1")]).toEqual([control.parentElement?.className, true]);
  }
  act(() => outside.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
  expect(api.selected.size).toBe(0);
  inside.forEach((control) => control.parentElement?.remove());
  outside.remove();
});

// 29회차: 회색 숨김을 켜면 가려지는 카드만 선택에서 뺀다(App 의 toggleGray) — 숨김은 목록(gens)을 줄이지 않아 규칙 42 효과가 걷지 못한다(Codex 코드 리뷰).
it("withoutHidden — 가려지는 카드만 빼고, 뺄 것이 없으면 같은 Set 을 돌려준다", () => {
  const selected = new Set(["a", "b", "c"]);
  expect([...withoutHidden(selected, new Set(["b", "x"]))]).toEqual(["a", "c"]);
  expect(withoutHidden(selected, new Set(["x"]))).toBe(selected);
  expect(withoutHidden(selected, new Set())).toBe(selected);
});

// 19회차(조작 규칙 46): 필터·폴더가 바뀌면(resetKey) 선택을 비우는 일이 '그린 뒤'로 밀려, 새 목록이 옛 선택과 함께 한 박자 그려졌다 —
//  그 박자의 색 키·삭제는 화면에서 사라진 카드들에 걸린다.
it("resetKey 가 바뀐 그 박자에 선택이 비어 있다 — 새 목록이 옛 선택과 함께 그려지지 않는다", () => {
  let api!: ReturnType<typeof useGenerationSelection>;
  function Probe({ resetKey }: { resetKey: string }) {
    api = useGenerationSelection({ resetKey });
    return <i data-picked={[...api.selected].join(",")} />;
  }
  const picked = () => host.querySelector("i")!.dataset.picked;
  act(() => root.render(<Probe resetKey="a" />));
  act(() => api.toggleSelect("g1"));
  expect(picked()).toBe("g1");
  let painted: string | undefined = "?";
  act(() => {
    flushSync(() => root.render(<Probe resetKey="b" />));
    painted = picked(); // 이 박자에 화면에 있는 것 — 다음 키가 보는 것
  });
  expect(painted).toBe("");
});
