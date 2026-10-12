// @vitest-environment jsdom
// 프로젝트 설정 창의 날짜 달력(조작 규칙 50 — 23회차 격리 실측에서 재현, 24회차에 고침): 설정 창에서는 CSS 가 달력을 **위로** 펼치는데 기간 칸이 창의
//  위쪽에 있어 900×600 에서 달력 윗부분 88px 이 화면 밖이었다 — 월을 바꾸는 ‹ › 와 제목에 닿지 못했다. 위에 남은 자리가 달력 높이보다 작으면 아래로
//  펼친다(창은 안에서 스크롤된다). jsdom 은 배치를 하지 않아 칸의 자리와 달력 높이를 시험이 넣는다.
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProjectDateRangePicker } from "../src/components/manage/ProjectDateRangePicker";

let host: HTMLDivElement;
let root: Root;
let fieldTop = 0; // 기간 칸(.project-date-range)의 위 끝 — 화면 좌표
const POP_HEIGHT = 324; // 실측한 달력 높이
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const top = this.classList.contains("project-date-range") ? fieldTop : 0;
    return { x: 0, y: top, top, bottom: top + 60, left: 0, right: 280, width: 280, height: 60, toJSON: () => ({}) } as DOMRect;
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("project-range-popover") ? POP_HEIGHT : 0;
  });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const css = (name: string) => readFileSync(new NodeURL(`../src/styles/${name}.css`, import.meta.url), "utf8");
const pop = () => host.querySelector<HTMLElement>(".project-range-popover")!;
const openStart = () => act(() => [...host.querySelectorAll<HTMLButtonElement>(".manage-date-button")][0].click());

it("설정 창에서 위에 자리가 모자라면 달력을 아래로 펼친다 — 창을 키워 자리가 생기면 다시 위로", () => {
  act(() => root.render(<><style>{css("composition-manage") + css("admin-auth-compare")}</style>
    <section className="project-settings-section"><ProjectDateRangePicker startDate="" dueDate="" onChange={() => {}} /></section></>));
  fieldTop = 243; // 900×600 의 설정 창 — 달력(324)을 위로 펼치면 top −88 이었다
  openStart();
  expect(pop().classList.contains("range-down")).toBe(true); // 전엔 늘 위로
  expect([getComputedStyle(pop()).top, getComputedStyle(pop()).bottom]).toEqual(["calc(100% + 7px)", "auto"]);

  fieldTop = 500; // 창을 키웠다(또는 창 안을 내렸다) — 위에 493px, 달력 324 + 여백 8 이 들어간다
  act(() => { window.dispatchEvent(new Event("resize")); });
  expect(pop().classList.contains("range-down")).toBe(false);
  expect([getComputedStyle(pop()).top, getComputedStyle(pop()).bottom]).toEqual(["auto", "calc(100% + 7px)"]); // 설정 창의 기본 — 위로
});

it("아래로 펼치는 자리(계획 창)에서는 겉모습이 달라지지 않는다 — 같은 값이다", () => {
  act(() => root.render(<><style>{css("composition-manage") + css("admin-auth-compare")}</style>
    <ProjectDateRangePicker startDate="" dueDate="" onChange={() => {}} /></>));
  fieldTop = 100;
  openStart();
  expect(getComputedStyle(pop()).top).toBe("calc(100% + 7px)");
  fieldTop = 900;
  act(() => { window.dispatchEvent(new Event("resize")); });
  expect(getComputedStyle(pop()).top).toBe("calc(100% + 7px)");
});
