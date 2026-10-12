// @vitest-environment jsdom
// 프롬프트의 @·# 피커는 패널 위로 뜬다 — 목록의 높이는 **패널 위에 실제로 남은 자리**까지만이다(조작 규칙 50 — 23회차, Codex 전수 검토).
// CSS 의 상한(화면 높이 − 150px)은 패널이 낮을 때만 맞는다: 레퍼런스 트레이를 펼친 낮은 창(900×600)에서는 피커의 윗부분이 화면 밖으로 나가
// 첫 항목들을 볼 수도 누를 수도 없었다. jsdom 은 배치를 하지 않아, 피커의 아래 끝(= 패널의 위)과 머리글 높이를 시험이 넣어 준다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SpotlightMentionPicker } from "../src/components/spotlight/SpotlightMentionPicker";

let host: HTMLDivElement;
let root: Root;
let pickerBottom = 0; // 피커의 아래 끝(화면 좌표) — 패널 위쪽에 묶여 있다
const HEAD = 34; // 머리글 + 테두리
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const bottom = this.classList.contains("sl-mention") ? pickerBottom : 0;
    return { x: 0, y: 0, left: 0, top: 0, right: 340, bottom, width: 340, height: 0, toJSON: () => ({}) } as DOMRect;
  });
  // 목록은 내용이 넉넉해 늘 상한(max-height)만큼 찬다 — 인라인 상한이 없으면 CSS 의 450px. 피커 전체 = 목록 + 머리글.
  const listHeightOf = (list: HTMLElement | null) => (list?.style.maxHeight ? Number.parseFloat(list.style.maxHeight) : 450);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains("sl-mention-list")) return listHeightOf(this);
    return this.classList.contains("sl-mention") ? listHeightOf(this.querySelector<HTMLElement>(".sl-mention-list")) + HEAD : 0;
  });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const picker = () => (
  <SpotlightMentionPicker mention={{ kind: "#", query: "" }} tagList={["a", "b", "c"]} tagCounts={new Map()} sourceList={[]} activeIndex={0}
    listRef={{ current: null } as never} assetProject={null} tagFilter={null} onHoverIndex={() => {}} onSelectTag={() => {}}
    onSelectSource={() => {}} trayList={[]} onSelectTrayRef={() => {}} />
);
const listHeight = () => host.querySelector<HTMLElement>(".sl-mention-list")!.style.maxHeight;
/** 피커의 위 끝(화면 좌표) — 아래 끝에서 목록·머리글을 뺀 자리. 8px(위 여백) 아래로 내려가면 화면 밖이다. */
const pickerTop = () => pickerBottom - (Number.parseFloat(listHeight()) + HEAD);

it("목록의 높이를 패널 위에 남은 자리로 잰다 — 낮은 창에서 피커의 윗부분이 화면 밖으로 나가지 않는다", () => {
  function Shell() {
    return <div className="sl-panel">{picker()}</div>;
  }
  pickerBottom = 362; // 900×600 · 트레이를 펼친 패널: 패널 위 = 370, 피커는 그 8px 위
  act(() => root.render(<Shell />));
  expect([listHeight(), pickerTop()]).toEqual(["320px", 8]); // 362 − 위 여백 8 − 머리글 34 — 전엔 CSS 의 450px(위쪽 130px 이 화면 밖)
  act(() => root.render(<Shell />)); // 다시 재도 같은 값이다(줄어든 목록을 기준으로 또 줄지 않는다)
  expect([listHeight(), pickerTop()]).toEqual(["320px", 8]);

  pickerBottom = 900; // 높은 창 — 상한 760
  act(() => { window.dispatchEvent(new Event("resize")); });
  expect(listHeight()).toBe("760px");

  pickerBottom = 80; // 아주 낮은 창(여러 줄을 쳐 패널이 커졌다) — 남은 자리만큼만. 최소 높이를 두면 그만큼 다시 화면 밖으로 나간다
  act(() => root.render(<Shell />)); // 다시 그려질 때마다 잰다(글을 치면 패널 높이가 달라진다)
  expect([listHeight(), pickerTop()]).toEqual(["38px", 8]); // 전(최소 96px): 위 끝이 −50px
});
