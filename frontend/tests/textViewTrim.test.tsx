// @vitest-environment jsdom
// 글 카드 보기 칸에는 보이는 만큼만(2026-11-10) — 실제 씬의 글 카드 33장에 58만 자가 들어 있어 줌할 때마다 그 글을 모두 다시 그렸다.
//  원문은 편집·마우스 올림·안쪽 스크롤·카드 안 포커스 때 · 넣은 글이 칸을 못 채우면 늘린다 · 토큰·글자 덩어리 중간에서 안 자르고 줄임표 없음.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TextCard } from "../src/components/scene/cards/TextCard";
import { cutTextForView, textViewBudget } from "../src/lib/textNodeTokens";
import type { SceneCard } from "../src/lib/scenes";

describe("cutTextForView · textViewBudget", () => {
  it("짧으면 그대로, 길면 limit 이하로 앞부분만 — 줄임표를 붙이지 않는다", () => {
    expect(cutTextForView("짧은 글", 100)).toBe("짧은 글");
    const long = "가나다라마바사 ".repeat(500);
    const cut = cutTextForView(long, 300);
    expect(cut.length).toBeLessThanOrEqual(300);
    expect(long.startsWith(cut)).toBe(true);
    expect(cut).not.toMatch(/(…|\.\.\.)$/);
  });

  it("토큰(@image12 · <<<image3>>>)이 자르는 자리를 걸치면 그 토큰 앞에서 자른다", () => {
    const text = "a".repeat(95) + " @image12 이어지는 글" + "b".repeat(200);
    expect(cutTextForView(text, 100)).toBe("a".repeat(95) + " "); // @image12 는 96..104 — 100 에서 자르면 반쪽
    const comfy = "a".repeat(90) + "<<<image3>>>" + "c".repeat(200);
    expect(cutTextForView(comfy, 95)).toBe("a".repeat(90));
  });

  it("이모지·결합 문자 덩어리 한가운데서 자르지 않는다", () => {
    const family = "👨‍👩‍👧"; // ZWJ 로 이은 한 덩어리(코드 단위 8)
    const text = "x".repeat(98) + family + "y".repeat(100);
    const cut = cutTextForView(text, 101); // 덩어리 안쪽
    expect(cut).toBe("x".repeat(98));
    const accent = "x".repeat(99) + "é" + "z".repeat(100); // e + 결합 악센트
    expect(cutTextForView(accent, 100)).toBe("x".repeat(99));
    // 결합 문자가 길게 이어진 덩어리 — 나누기를 그 한가운데서 시작하면 경계를 잘못 봤다(독립 리뷰 P2 재현)
    const longCluster = "x".repeat(80) + "a" + "́".repeat(40) + "z".repeat(100);
    expect(cutTextForView(longCluster, 110)).toBe("x".repeat(80));
    const skin = "x".repeat(97) + "👍🏽" + "y".repeat(50); // 기본 이모지 + 피부색(서로게이트 둘씩)
    expect(cutTextForView(skin, 100)).toBe("x".repeat(97));
    // 이음 문자로 길게 이은 이모지 · 결합 문자 600개 — 경계를 원문 처음부터 세야 맞다(독립 리뷰 P2 재현 둘)
    const zwjChain = "x".repeat(80) + "👩‍".repeat(10) + "👩" + "z".repeat(100);
    expect(cutTextForView(zwjChain, 105)).toBe("x".repeat(80));
    const hugeCluster = "x".repeat(80) + "a" + "́".repeat(600) + "z".repeat(100);
    expect(cutTextForView(hugeCluster, 650)).toBe("x".repeat(80));
  });

  it("후보 길이는 카드가 클수록 길고, 아무리 작아도 400자 이상", () => {
    expect(textViewBudget(400, 264)).toBeGreaterThanOrEqual(400);
    expect(textViewBudget(484, 462)).toBeGreaterThan(textViewBudget(400, 264));
    expect(textViewBudget(0, 0)).toBe(400);
  });
});

describe("TextCard 보기 칸", () => {
  let host: HTMLDivElement;
  let root: Root;
  const noop = () => {};
  const LONG = Array.from({ length: 600 }, (_, i) => `${i}번째 줄 — 노을 진 언덕을 걷는 장면, 카메라는 천천히 뒤로 빠진다.`).join("\n");
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  const render = (editing = false, text = LONG) => {
    const card: SceneCard = { id: "t", kind: "text", x: 0, y: 0, w: 400, h: 264, text };
    act(() => root.render(
      <div className="scene-card">
        <TextCard card={card} cardsById={new Map([["t", card]])} resolvedEdges={[]} genData={{}} editing={editing}
          caretPosRef={{ current: new Map() }} setEditTextId={noop} setSelected={noop} setNodeText={noop}
          flushPending={noop} onOutPortDown={noop} onResizeDown={noop} />
      </div>,
    ));
  };
  const view = () => host.querySelector<HTMLElement>(".scene-textview-inline")!;

  it("평소엔 앞부분만, 올리면 원문, 떼면 다시 앞부분만 — 안쪽을 내려 봤으면 원문을 둔다", () => {
    render();
    const trimmed = view().textContent!.length;
    expect(trimmed).toBeLessThan(LONG.length);
    expect(LONG.startsWith(view().textContent!)).toBe(true);
    act(() => { view().dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body })); });
    expect(view().textContent).toBe(LONG);
    act(() => { view().dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body })); });
    expect(view().textContent!.length).toBe(trimmed);
    // 올려서 안쪽을 내린 뒤 떼면 원문 그대로(내려 본 자리가 비지 않게)
    act(() => { view().dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body })); });
    act(() => { view().scrollTop = 120; view().dispatchEvent(new Event("scroll")); });
    act(() => { view().dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body })); });
    expect(view().textContent).toBe(LONG);
  });

  it("편집 중이거나 카드 안에 포커스가 있으면 원문", () => {
    render(true);
    expect(view().textContent).toBe(LONG);
    render(false);
    expect(view().textContent!.length).toBeLessThan(LONG.length);
    const button = host.querySelector<HTMLButtonElement>(".scene-copy-btn")!;
    act(() => button.focus());
    expect(view().textContent).toBe(LONG);
    act(() => button.blur());
    expect(view().textContent!.length).toBeLessThan(LONG.length);
  });

  it("넣은 글이 보기 칸을 못 채우면(좁은 글자) 후보를 늘린다 — 원문 길이에 닿으면 원문", () => {
    // 칸 높이 264, 넣은 글 높이 = 글자 수 ÷ 40 으로 흉내 — 처음 후보(약 1,200자)로는 30px 뿐이라 늘려야 한다
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(264);
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("scene-textview-inline") ? Math.floor((this.textContent || "").length / 40) : 0;
    });
    render();
    const len = view().textContent!.length;
    expect(len).toBeGreaterThan(264 * 40); // 칸을 넘칠 만큼 늘렸다
    expect(len).toBeLessThan(LONG.length); // 그래도 원문 전부는 아니다
  });

  it("늘려도 같은 앞부분이 나오는 글(첫 글자 덩어리가 아주 김)도 멈추지 않고 늘려 칸이 비지 않는다", () => {
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(264);
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("scene-textview-inline") ? Math.floor((this.textContent || "").length / 10) : 0;
    });
    const tricky = "a" + "́".repeat(3000) + "z".repeat(1000); // 첫 덩어리 3,001자 — 후보 1·2배로는 빈 글
    render(false, tricky);
    expect(view().textContent!.length).toBeGreaterThan(0);
    expect(view().textContent!.startsWith("á")).toBe(true);
  });

  it("짧은 글은 자르지 않는다", () => {
    render(false, "짧은 프롬프트");
    expect(view().textContent).toBe("짧은 프롬프트");
  });
});
