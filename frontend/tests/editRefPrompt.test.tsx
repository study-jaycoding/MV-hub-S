// @vitest-environment jsdom
// 수정 창 지시문 알약(Jay 2026-10-28 A+B): @imageN = 레퍼런스 칸 그 번호의 썸네일 알약 · 칸에 없는 번호 = 경고 알약 ·
//  @ 를 치면 레퍼런스 칸 목록 · 내보내는 글은 '@image2' 글자 그대로 · 이미지 수정(칸 없음)은 글만.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditRefPrompt, type EditPromptRef } from "../src/components/edit/EditRefPrompt";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const REFS: EditPromptRef[] = [
  { token: "@image1", kind: "image", name: "그린 프레임", thumb: "/frame.png" },
  { token: "@image2", kind: "image", name: "매튜_표정", thumb: "/sheet.png" },
];
const onChange = vi.fn();
const onSubmit = vi.fn();
const show = (value = "", refs = REFS) => act(() => root.render(
  <div className="sl-prompt-row"><EditRefPrompt value={value} onChange={onChange} onSubmit={onSubmit} placeholder="입력" ariaLabel="수정 지시" refs={refs} /></div>,
));
const box = () => host.querySelector<HTMLElement>('[aria-label="수정 지시"]')!;
// 글을 넣고 캐럿을 끝에 두고 입력 이벤트 — 사용자가 친 것과 같은 길
const type = (text: string) => act(() => {
  const el = box();
  el.focus(); // 실제로 치는 중엔 칸에 초점이 있다(초점 없이 focus() 를 부르면 jsdom 이 캐럿을 앞으로 옮긴다)
  el.textContent = text;
  const range = document.createRange();
  range.setStart(el.firstChild!, text.length);
  range.collapse(true);
  getSelection()!.removeAllRanges();
  getSelection()!.addRange(range);
  el.dispatchEvent(new Event("input", { bubbles: true }));
});
const key = (k: string, extra: KeyboardEventInit = {}) => act(() => { box().dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...extra })); });

beforeEach(() => { onChange.mockClear(); onSubmit.mockClear(); });

it("@image2 는 그 칸의 썸네일 알약, 칸에 없는 @image3 은 경고 알약 — 내보내는 글은 그대로", () => {
  show();
  type("표정을 @image2 안의 11번으로, 손은 @image3 처럼");
  const pills = [...box().querySelectorAll<HTMLElement>(".sl-tok")];
  expect(pills.map((p) => p.textContent)).toEqual(["@image2", "@image3"]);
  expect(pills[0].querySelector("img")!.getAttribute("src")).toContain("/sheet.png");
  expect(pills[1].classList.contains("sl-tok-missing")).toBe(true);
  expect(onChange).toHaveBeenLastCalledWith("표정을 @image2 안의 11번으로, 손은 @image3 처럼");
});

it("@ 를 치면 레퍼런스 칸 목록 — 화살표·Enter 로 고르면 알약이 들어가고 제출되지 않는다", () => {
  show();
  type("표정은 @im");
  const names = () => [...host.querySelectorAll(".pe-ref-pick .sl-mention-name")].map((n) => n.textContent);
  expect(names()).toEqual(["@image1", "@image2"]);
  key("ArrowDown");
  expect(host.querySelector(".pe-ref-pick .sl-mention-item.on .sl-mention-name")!.textContent).toBe("@image2");
  key("Enter");
  expect(host.querySelector(".pe-ref-pick")).toBeNull();
  expect(box().querySelector(".sl-tok")!.textContent).toBe("@image2");
  expect(onChange).toHaveBeenLastCalledWith("표정은 @image2");
  expect(onSubmit).not.toHaveBeenCalled();
});

it("목록이 없을 때 Enter = 제출, 한글 조합 중 Enter 는 아니다 · 밖에서 비우면 칸도 빈다", () => {
  show();
  type("옷 색을 바꿔 주세요");
  key("Enter", { keyCode: 229 });
  expect(onSubmit).not.toHaveBeenCalled();
  key("Enter");
  expect(onSubmit).toHaveBeenCalledTimes(1);
  show("옷 색을 바꿔 주세요"); // 앱에선 onChange 가 부모 값을 바꾼다 — 그다음 비우기 단추가 ""
  show("");
  expect(box().textContent).toBe("");
  expect(box().hasAttribute("data-empty")).toBe(true);
});

it("레퍼런스 칸이 없으면(이미지 수정) 알약·목록 없이 글만", () => {
  show("", []);
  type("@image2 를 참고해");
  expect(box().querySelector(".sl-tok")).toBeNull();
  type("표정은 @");
  expect(host.querySelector(".pe-ref-pick")).toBeNull();
});
