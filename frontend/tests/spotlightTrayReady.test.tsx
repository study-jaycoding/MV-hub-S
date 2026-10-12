// @vitest-environment jsdom
// 트레이가 '지금의 묶임'에 맞춰졌는가(trayReady) — 묶인 카드(씬)가 바뀐 렌더에는 트레이가 아직 앞 카드의 레퍼런스를 들고 있다.
// 그 한 박자의 제출은 앞 카드의 레퍼런스로 나갔다(2026-10-11 Codex 코드 리뷰). 제출은 trayReady 를 본다(spotlightSubmitRender 시험).
import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SceneRef } from "../src/lib/scenes";
import { useSpotlightTray } from "../src/lib/useSpotlightTray";

type Binding = { key: string; refs: SceneRef[] } | null;
let host: HTMLDivElement;
let root: Root;
let renders: string[]; // 렌더마다의 '묶임:준비됐나:트레이 레퍼런스 수'
const accepted = vi.fn((refs: SceneRef[]) => refs);

function Probe({ binding }: { binding: Binding }) {
  const tray = useSpotlightTray({ trayBinding: binding, onTrayBindingRefsChange: accepted, onImportFiles: () => {} });
  renders.push(`${binding?.key ?? "-"}:${tray.trayReady}:${tray.trayRefs.length}`);
  return null;
}
const ref = (name: string): SceneRef => ({ type: "image", file_path: `/fixtures/${name}.png`, name, thumb: `/fixtures/${name}.png` });

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  renders = [];
  accepted.mockClear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it("묶임이 바뀐 렌더에는 준비 안 됨(앞 카드의 레퍼런스가 남아 있다) — 트레이가 새 묶임의 것으로 바뀐 렌더부터 준비됨", () => {
  act(() => root.render(<Probe binding={{ key: "s1:c1", refs: [ref("a"), ref("b")] }} />));
  expect(renders.at(-1)).toBe("s1:c1:true:2");

  // 씬을 바꿨다 — 카드 선택이 풀려 '선택 없음'(레퍼런스 0)으로 묶인다. 탭 누름은 동기 렌더고 트레이 갱신은 그 뒤로 밀린다.
  renders = [];
  act(() => { flushSync(() => root.render(<Probe binding={{ key: "s2:none", refs: [] }} />)); });
  expect(renders[0]).toBe("s2:none:false:2"); // 이 렌더의 제출은 앞 카드의 레퍼런스 2개를 싣게 된다 — 준비 안 됨
  expect(renders.at(-1)).toBe("s2:none:true:0");

  // 같은 레퍼런스를 가진 다른 카드로 옮겨도(트레이 내용은 그대로) 한 박자 뒤에는 준비됨
  act(() => root.render(<Probe binding={{ key: "s2:c9", refs: [] }} />));
  expect(renders.at(-1)).toBe("s2:c9:true:0");
});

// 19회차(조작 규칙 46): 위의 '준비 안 됨' 렌더가 **그려지면** 안 된다 — 그려진 트레이의 ×·순서 바꾸기·Shift+Backspace 는 제출처럼 막혀 있지 않아,
//  앞 카드의 트레이를 보고 누른 것이 새 카드의 레퍼런스에 적용됐다(같은 자리의 다른 레퍼런스가 빠진다).
it("묶임이 바뀐 그 박자에 그려진 트레이는 이미 새 묶임의 것이다 — 따라간 것을 카드에 되적지도 않는다", () => {
  function Painted({ binding }: { binding: Binding }) {
    const tray = useSpotlightTray({ trayBinding: binding, onTrayBindingRefsChange: accepted, onImportFiles: () => {} });
    return <i data-refs={tray.trayRefs.map((item) => item.name).join(",")} />;
  }
  const shown = () => host.querySelector("i")!.dataset.refs;
  act(() => root.render(<Painted binding={null} />)); // 앱에서 프롬프트는 묶임 없이 먼저 뜬다
  act(() => root.render(<Painted binding={{ key: "s1:c1", refs: [ref("a"), ref("b")] }} />));
  expect(shown()).toBe("a,b");
  expect(accepted).not.toHaveBeenCalled();
  let painted: string | undefined = "?";
  act(() => {
    flushSync(() => root.render(<Painted binding={{ key: "s1:c2", refs: [ref("x"), ref("y")] }} />));
    painted = shown(); // 이 박자에 화면에 있는 트레이 — 다음 누름이 보는 것
  });
  expect(painted).toBe("x,y");
  expect(accepted).not.toHaveBeenCalled();
});

it("묶임이 없는 화면(라이브러리)과 같은 묶임이 유지되는 동안은 늘 준비됨", () => {
  act(() => root.render(<Probe binding={null} />));
  expect(renders.every((line) => line.startsWith("-:true"))).toBe(true);
  const binding = { key: "s1:c1", refs: [ref("a")] };
  act(() => root.render(<Probe binding={binding} />));
  renders = [];
  act(() => root.render(<Probe binding={{ ...binding }} />)); // 같은 묶임의 재렌더
  expect(renders.every((line) => line === "s1:c1:true:1")).toBe(true);
});
