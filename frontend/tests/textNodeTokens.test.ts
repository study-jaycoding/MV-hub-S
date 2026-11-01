// @vitest-environment jsdom
// 텍스트 노드 편집칸 알약(Jay 2026-10-29) — 이어진 번호만 감싸고 알약 안에 원래 글자를 그대로 둔다(저장 글 = 친 그대로).
import { afterEach, describe, expect, it } from "vitest";
import {
  caretMention,
  caretTextOffset,
  editorText,
  placeCaretAtTextOffset,
  wrapTextTokens,
} from "../src/lib/textNodeTokens";

const refs = new Map<string, string | undefined>([["@image1", "/a.png"], ["@image2", undefined], ["@video1", "/v.png"], ["@audio1", undefined]]);
let el: HTMLDivElement;
const editor = (text: string) => {
  el = document.createElement("div");
  el.contentEditable = "true";
  el.textContent = text;
  document.body.append(el);
  return el;
};
const caretAt = (node: Node, offset: number) => {
  const r = document.createRange();
  r.setStart(node, offset);
  r.collapse(true);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(r);
};
const pills = () => [...el.querySelectorAll("[data-tok]")].map((p) => [p.className, p.textContent]);
afterEach(() => { el?.remove(); window.getSelection()?.removeAllRanges(); });

describe("wrapTextTokens", () => {
  it("이어진 번호만 알약 · 원래 글자 그대로(<<<image1>>>·@simage1 도) · 이어지지 않은 번호는 글자", () => {
    editor("@image1 과 <<<image1>>>, @simage1 @eimage2 @video1 @audio1 @image9 me@x");
    wrapTextTokens(el, refs, false);
    expect(pills()).toEqual([
      ["scene-inlinetok k-image", "@image1"],
      ["scene-inlinetok k-image", "<<<image1>>>"],
      ["scene-inlinetok k-start", "@simage1"],
      ["scene-inlinetok k-end", "@eimage2"],
      ["scene-inlinetok k-video", "@video1"],
      ["scene-inlinetok k-audio", "🎵@audio1"], // 음표는 그림 자리 — 글에는 안 들어간다
    ]);
    expect(editorText(el)).toBe("@image1 과 <<<image1>>>, @simage1 @eimage2 @video1 @audio1 @image9 me@x");
    expect(el.querySelector("[data-tok]")!.getAttribute("contenteditable")).toBe("false");
  });
  it("편집칸 안에 고른 글이 있으면 치는 중에는 알약으로 바꾸지 않아 선택이 그대로다 — 칸을 떠날 때는 바꾼다", () => {
    editor("@image1 바꿀 글");
    const text = el.firstChild!;
    const range = document.createRange();
    range.selectNodeContents(el);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    wrapTextTokens(el, refs, true);
    expect(pills()).toEqual([]);
    expect(el.firstChild).toBe(text);
    expect(window.getSelection()!.toString()).toBe("@image1 바꿀 글");
    wrapTextTokens(el, refs, false);
    expect(pills().map(([, t]) => t)).toEqual(["@image1"]);
  });
  it("칸 밖의 선택은 변환을 막지 않는다", () => {
    editor("@image1 글");
    const outside = document.createElement("p");
    outside.textContent = "밖";
    document.body.append(outside);
    const range = document.createRange();
    range.selectNodeContents(outside);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    wrapTextTokens(el, refs, true);
    expect(pills().map(([, t]) => t)).toEqual(["@image1"]);
    outside.remove();
  });
  it("캐럿이 걸친 토큰(끝 경계 포함)은 치는 중이라 글자로 두고, 캐럿은 같은 글자 자리로 돌아온다", () => {
    editor("@image1 그리고 @image2");
    caretAt(el.firstChild!, "@image1 그리고 @image2".length);
    wrapTextTokens(el, refs, true);
    expect(pills().map(([, t]) => t)).toEqual(["@image1"]);
    expect(caretTextOffset(el)).toBe("@image1 그리고 @image2".length);
    wrapTextTokens(el, refs, false); // 칸을 떠나면 다
    expect(pills().map(([, t]) => t)).toEqual(["@image1", "@image2"]);
    expect(editorText(el)).toBe("@image1 그리고 @image2");
  });
  it("따로 된 Text 노드는 이어 본다 — 푼 알약 끝에 붙여 넣은 숫자가 옛 번호 알약으로 돌아가지 않는다", () => {
    editor("");
    el.append(document.createTextNode("@image1"), document.createTextNode("2"));
    wrapTextTokens(el, refs, false);
    expect(pills().map(([, t]) => t)).toEqual([]); // @image12 는 없는 번호다
    expect(editorText(el)).toBe("@image12");
    expect(el.childNodes).toHaveLength(1);
    editor("");
    el.append(document.createTextNode("@ima"), document.createTextNode("ge1"));
    wrapTextTokens(el, refs, false);
    expect(pills().map(([, t]) => t)).toEqual(["@image1"]);
  });
  it("칸 안 요소에 든 따로 된 Text 노드도 이어 본다", () => {
    editor("");
    const line = document.createElement("div");
    line.append(document.createTextNode("@image1"), document.createTextNode("2"));
    el.append(line);
    wrapTextTokens(el, refs, false);
    expect(pills()).toEqual([]);
    expect(editorText(el)).toBe("@image12");
  });
  it("요소 경계에 있던 캐럿은 합쳐도 그 자리에 남는다", () => {
    editor("");
    const line = document.createElement("div");
    line.append(document.createTextNode("@image1"), document.createTextNode("2"));
    el.append(document.createTextNode("앞"), line);
    caretAt(line, 0);
    wrapTextTokens(el, refs, true);
    expect(window.getSelection()!.anchorNode).toBe(line);
    expect(editorText(el)).toBe("앞@image12");
  });
  it("이어진 Text 노드에 캐럿이 있어도 토큰 보호와 캐럿 자리가 이어진다", () => {
    editor("");
    const pasted = document.createTextNode("2");
    el.append(document.createTextNode("@image"), pasted);
    caretAt(pasted, 1);
    wrapTextTokens(el, new Map([["@image2", undefined]]), true);
    expect(pills()).toEqual([]); // 치는 중 — 글자로 둔다
    expect(caretTextOffset(el)).toBe("@image2".length);
    wrapTextTokens(el, new Map([["@image2", undefined]]), false);
    expect(pills().map(([, t]) => t)).toEqual(["@image2"]);
  });
  it("캐럿이 빈 Text 노드에 있으면 합치지 않아 캐럿이 그 자리에 남는다", () => {
    editor("");
    const empty = document.createTextNode("");
    el.append(document.createTextNode("@image1"), empty);
    caretAt(empty, 0);
    wrapTextTokens(el, refs, true);
    expect(window.getSelection()!.anchorNode).toBe(empty);
    expect(empty.isConnected).toBe(true);
  });
  it("고른 글이 있어 미루면 합치지도 않는다", () => {
    editor("");
    const a = document.createTextNode("@image1");
    el.append(a, document.createTextNode("2"));
    const r = document.createRange();
    r.setStart(a, 0);
    r.setEnd(a, 3);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(r);
    wrapTextTokens(el, refs, true);
    expect(el.childNodes).toHaveLength(2);
  });
  it("토큰이 걸치지 않은 조각은 합치지 않는다 — 합치면 글 중간 줄바꿈 뒤 Ctrl+Z 가 글을 통째로 지운다(실제 크롬)", () => {
    editor("");
    const parts = [document.createTextNode("abc"), document.createTextNode("\n"), document.createTextNode("def")];
    el.append(...parts);
    wrapTextTokens(el, refs, true);
    expect([...el.childNodes]).toEqual(parts);
  });
  it("토큰이 걸친 조각만 합치고 다른 조각은 그대로 둔다", () => {
    editor("");
    const first = document.createTextNode("줄\n");
    const line = document.createTextNode("끝");
    const left = document.createTextNode("@image1");
    el.append(first, line, left, document.createTextNode("2"));
    wrapTextTokens(el, refs, false);
    expect([...el.childNodes].slice(0, 2)).toEqual([first, line]);
    expect(left.data).toBe("@image12");
    expect(el.childNodes).toHaveLength(3);
    expect(editorText(el)).toBe("줄\n끝@image12");
  });
  it.each([[["@ima", "ge1", "2"]], [["@im", "a", "ge12"]], [["@", "i", "m", "age12"]]])("토큰이 여러 조각에 걸쳐도 저장 글과 같은 번호로 본다 %j", (pieces) => {
    editor("");
    el.append(...pieces.map((piece) => document.createTextNode(piece)));
    const refsWith12 = new Map([...refs, ["@image12", undefined]]);
    wrapTextTokens(el, refsWith12, false);
    expect(pills().map(([, t]) => t)).toEqual(["@image12"]);
    expect(editorText(el)).toBe("@image12");
  });
  it("세 조각의 가운데 조각에 있던 캐럿도 그 글자 자리에 남는다", () => {
    editor("");
    const middle = document.createTextNode("ag");
    el.append(document.createTextNode("@im"), middle, document.createTextNode("e12"));
    caretAt(middle, 1);
    wrapTextTokens(el, new Map(), true);
    expect(editorText(el)).toBe("@image12");
    expect(caretTextOffset(el)).toBe(4);
  });
  it("두 조각 사이(요소 경계)의 캐럿은 합쳐도 그 글자 자리에 남는다", () => {
    editor("");
    el.append(document.createTextNode("@image1"), document.createTextNode("2"));
    const r = document.createRange();
    r.setStart(el, 1);
    r.collapse(true);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(r);
    wrapTextTokens(el, new Map(), true);
    expect(editorText(el)).toBe("@image12");
    expect(caretTextOffset(el)).toBe("@image1".length);
  });
  it("토큰이 조각 경계 양쪽에 있으면 합쳐서 하나의 토큰으로 본다", () => {
    editor("");
    el.append(document.createTextNode("<<<ima"), document.createTextNode("ge1>>> 끝"));
    wrapTextTokens(el, refs, false);
    expect(pills().map(([, t]) => t)).toEqual(["<<<image1>>>"]);
    expect(editorText(el)).toBe("<<<image1>>> 끝");
  });
  it("감쌀 것이 없으면 DOM 을 건드리지 않는다 · 이미 감싼 알약은 다시 감싸지 않는다", () => {
    editor("그냥 글 @image9");
    const before = el.firstChild;
    wrapTextTokens(el, refs, false);
    expect(el.firstChild).toBe(before);
    editor("@image1");
    wrapTextTokens(el, refs, false);
    const pill = el.querySelector("[data-tok]");
    wrapTextTokens(el, refs, false);
    expect(el.querySelector("[data-tok]")).toBe(pill);
  });
});

describe("캐럿·글 꺼내기", () => {
  it("앞쪽 빈 줄의 캐럿은 첫 줄로 가지 않는다 · 칸 전체가 <br> 하나면 빈 글이다", () => {
    editor("\nABC");
    placeCaretAtTextOffset(el, 1);
    expect(caretTextOffset(el)).toBe(1);
    expect(editorText(el)).toBe("\nABC");
    editor("");
    el.innerHTML = "<br>";
    expect(editorText(el)).toBe("");
  });
  it("글자 위치 왕복 — 알약 안쪽이면 그 알약 뒤 · 넘치면 끝 · 다 지운 뒤의 <br> 하나는 빈 글", () => {
    editor("가 @image1 나");
    wrapTextTokens(el, refs, false);
    placeCaretAtTextOffset(el, 4); // '@image1' 안쪽
    expect(caretTextOffset(el)).toBe("가 @image1".length);
    placeCaretAtTextOffset(el, 1);
    expect(caretTextOffset(el)).toBe(1);
    placeCaretAtTextOffset(el, 999);
    expect(caretTextOffset(el)).toBe("가 @image1 나".length);
    el.innerHTML = "<br>";
    expect(editorText(el)).toBe("");
    el.innerHTML = "줄1<br>줄2";
    expect(editorText(el)).toBe("줄1\n줄2");
  });
  it("@ 고르기 감지 — 글 처음·띄어쓰기 뒤의 @ 와 영문·숫자 · 메일 주소·알약 안은 아님", () => {
    editor("앞 @vi");
    caretAt(el.firstChild!, "앞 @vi".length);
    expect(caretMention(el)).toMatchObject({ start: 2, query: "vi" });
    editor("me@image");
    caretAt(el.firstChild!, "me@image".length);
    expect(caretMention(el)).toBeNull();
    editor("@image1");
    wrapTextTokens(el, refs, false);
    caretAt(el.querySelector("[data-tok]")!.lastChild!, 3);
    expect(caretMention(el)).toBeNull();
  });
});
