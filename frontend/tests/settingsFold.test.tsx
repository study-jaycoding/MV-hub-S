// @vitest-environment jsdom
// 설정 창(Jay 2026-11-16 '같은 창에서 목록, 항목은 옆 창') — 처음엔 [기본 설정][외부 프로그램] + MV 업데이트, 묶음을 누르면 같은 창이
//  그 묶음의 목록으로 바뀌고(‹ 뒤로), 목록의 항목을 누르면 그 항목 칸만 담은 옆 창이 열린다. 항목 제목 밑 상태 줄은 늘 보인다
//  ("실시간 정보는 접기 밖", Jay 08-20). 옆 창은 숨긴 채 붙여 둔다 — 칸들의 조회·상태 줄이 열기 전에도 돈다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// 가짜는 바깥 경계(서버 호출)에만 — 응답은 '아직 안 옴'(창의 틀과 목록은 응답 없이도 그려진다)
vi.mock("../src/api", () => {
  const pending = () => new Promise(() => {});
  return { api: new Proxy({}, { get: () => pending }), GEN_PAGE: 200 };
});

import { SettingsFold } from "../src/components/settings/SettingsFold";
import { SettingsPanel } from "../src/components/SettingsPanel";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const float = () => document.querySelector<HTMLElement>(".settings-float")!;
const items = () => [...float().querySelectorAll<HTMLElement>(".settings-fold")];
const titleOf = (item: HTMLElement) => item.querySelector(".settings-fold-title")!.textContent;
const summaryOf = (item: HTMLElement) => item.querySelector(".settings-fold-summary")?.textContent;
const panelOf = (item: HTMLElement) => document.getElementById(item.querySelector(".settings-fold-head")!.getAttribute("aria-controls")!)!;
const sectionsOf = (item: HTMLElement) => [...panelOf(item).querySelectorAll(".settings-group-content > .settings-section > h4")].map((h) => h.textContent);
const openGroup = (title: string) => act(() => {
  [...float().querySelectorAll<HTMLButtonElement>(".settings-group-toggle")].find((button) => button.textContent?.includes(title))!.click();
});
const openItem = (item: HTMLElement) => act(() => item.querySelector<HTMLButtonElement>(".settings-fold-head")!.click());

it("목록의 한 줄 — 옆 창은 숨긴 채 붙어 있고(칸이 돈다) 제목 밑 줄은 보인다 · 누르면 옆 창을 열고 다시 누르면 닫는다", () => {
  act(() => root.render(<SettingsFold title="항목" summary="지금 상태"><button type="button">안쪽</button></SettingsFold>));
  const head = host.querySelector<HTMLButtonElement>(".settings-fold-head")!;
  const panel = document.getElementById(head.getAttribute("aria-controls")!)!;
  expect([head.getAttribute("aria-expanded"), panel.hidden, panel.querySelector(".settings-group-content")!.textContent,
    host.querySelector(".settings-fold-summary")?.textContent, panel.querySelector(".settings-group-flyout-head strong")!.textContent])
    .toEqual(["false", true, "안쪽", "지금 상태", "항목"]);
  act(() => head.click());
  expect([head.getAttribute("aria-expanded"), panel.hidden, host.querySelector(".settings-fold")!.classList.contains("is-open")]).toEqual(["true", false, true]);
  act(() => head.click());
  expect([head.getAttribute("aria-expanded"), panel.hidden]).toEqual(["false", true]);
});

it("목록의 한 줄 — 상태 줄이 비면 그 줄을 그리지 않는다", () => {
  act(() => root.render(<SettingsFold title="항목" summary=""><p>안쪽</p></SettingsFold>));
  expect(host.querySelector(".settings-fold-summary")).toBeNull();
});

it("설정 창 — 처음엔 두 묶음 + MV 업데이트, 묶음을 누르면 같은 창이 목록으로 바뀌고 항목마다 옆 창에 칸이 제자리에 있다", async () => {
  await act(async () => root.render(<SettingsPanel onClose={() => {}} onOpenMcp={() => {}} />));
  expect([...float().querySelectorAll(".settings-group-title")].map((title) => title.textContent)).toEqual(["기본 설정", "외부 프로그램"]);
  expect([...float().querySelectorAll(".settings-group-summary")].map((line) => line.textContent))
    .toEqual(["화면 · 작업 · 자료 관리", "Slack · ComfyUI · DaVinci Resolve · MCP"]);
  expect([...float().querySelectorAll(".admin-body > .settings-section > h4")].map((h) => h.textContent)).toEqual(["MV 업데이트"]);
  expect(document.querySelector(".settings-group-flyout")).toBeNull(); // 처음엔 옆 창이 없다

  openGroup("기본 설정");
  expect(float().querySelector(".admin-title")!.textContent).toBe("기본 설정"); // 머리 = ‹ 뒤로 + 묶음 이름
  expect(float().querySelector(".settings-group-toggle")).toBeNull(); // 같은 창이 목록으로 바뀐다
  expect(float().querySelector(".admin-body > .settings-section")).toBeNull(); // MV 업데이트도 처음 화면에만
  expect(items().map(titleOf)).toEqual(["화면", "작업", "자료 관리"]);
  expect(items().map((item) => panelOf(item).hidden)).toEqual([true, true, true]);
  // 자료 관리 = 시안 2판의 ② 백업 · ③ 전송 · ④ 점검(저장 통합 1-A). 캔버스 자료는 백업 칸 안 '파일로 챙기기'의 하위 블록이고
  //  캔버스 저장소가 열린 창에서만 그린다(시험에는 저장소가 없다)
  expect(items().map(sectionsOf)).toEqual([
    ["강조색", "언어 · Language", "모션", "필터 테마"],
    ["다운로드 위치", "단축키"],
    ["백업", "전송", "점검"],
  ]);
  const data = panelOf(items()[2]);
  expect([...data.querySelectorAll(".settings-subgroup > h5")].map((h) => h.textContent))
    .toEqual(["다른 PC·서버에서 가져오기", "파일로 챙기기"]);
  expect([...data.querySelectorAll(".settings-action")].map((b) => b.textContent)).toContain("서버 백업 가져오기");
  expect(summaryOf(items()[0])).toBe("한글 · 모션 ON · 필터 기본");
  expect(items()[0].querySelector(".settings-fold-dot")).not.toBeNull(); // 강조색 점

  // 항목을 누르면 그 옆 창만 — 다른 항목을 누르면 옆 창이 그 항목으로 바뀐다
  openItem(items()[0]);
  expect(items().map((item) => panelOf(item).hidden)).toEqual([false, true, true]);
  expect(items().map((item) => item.classList.contains("is-open"))).toEqual([true, false, false]);
  openItem(items()[2]);
  expect(items().map((item) => panelOf(item).hidden)).toEqual([true, true, false]);

  // ‹ 뒤로 — 처음 화면으로, 옆 창은 닫힌다(목록과 함께 빠진다)
  act(() => float().querySelector<HTMLButtonElement>(".settings-back")!.click());
  expect([...float().querySelectorAll(".settings-group-title")].map((title) => title.textContent)).toEqual(["기본 설정", "외부 프로그램"]);
  expect(document.querySelector(".settings-group-flyout")).toBeNull();
  expect(document.activeElement?.textContent).toContain("기본 설정"); // 초점은 들어갔던 묶음 줄로

  openGroup("외부 프로그램");
  expect(items().map(titleOf)).toEqual(["Slack 알림", "ComfyUI", "DaVinci Resolve", "MV·MCP 연결"]);
  expect(items().map((item) => panelOf(item).hidden)).toEqual([true, true, true, true]);
  expect(sectionsOf(items()[1])).toEqual(["ComfyUI", "미회수 실행"]); // ComfyUI 제목은 CSS 로 숨긴다(hide-first-title)
  expect(items().map((item) => panelOf(item).classList.contains("hide-first-title"))).toEqual([true, true, true, true]);
  expect(summaryOf(items()[3])).toBe("Codex·Claude Code 연결");
});

it("설정 창 — MV·MCP 연결을 넘겨받지 않은 창에는 그 항목이 없다", async () => {
  await act(async () => root.render(<SettingsPanel onClose={() => {}} />));
  expect(float().querySelectorAll(".settings-group-summary")[1].textContent).toBe("Slack · ComfyUI · DaVinci Resolve");
  openGroup("외부 프로그램");
  expect(items().map(titleOf)).toEqual(["Slack 알림", "ComfyUI", "DaVinci Resolve"]);
});

it("MV 업데이트 — [다시 확인]은 새로 고침 아이콘 단추(이름은 title·aria-label), 단추 앞 그림 기호가 없다", async () => {
  await act(async () => root.render(<SettingsPanel onClose={() => {}} />));
  const refresh = document.querySelector<HTMLButtonElement>(".release-update-refresh")!;
  expect([refresh.title, refresh.getAttribute("aria-label"), refresh.textContent, !!refresh.querySelector("svg")]).toEqual(["다시 확인", "다시 확인", "", true]);
  openGroup("기본 설정");
  const labels = [...document.querySelectorAll<HTMLElement>(".settings-float .settings-action, .settings-group-flyout .settings-action")]
    .map((button) => button.textContent ?? "");
  expect(labels.filter((label) => /^[^\p{L}\p{N}]/u.test(label.trim()) && label.trim())).toEqual([]);
});
