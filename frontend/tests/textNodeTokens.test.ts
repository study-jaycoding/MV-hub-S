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
