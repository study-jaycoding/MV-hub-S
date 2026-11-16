// @vitest-environment jsdom
// 설정 창(Jay 2026-11-16 시안 v3) — 처음엔 [기본 설정][외부 프로그램] + MV Hub Update, 묶음을 누르면 그 밑으로 항목이 펼쳐지고,
//  항목을 누르면 그 항목 칸만 담은 옆 창이 열린다. 항목 제목 밑 상태 줄은 늘 보인다("실시간 정보는 접기 밖", Jay 08-20).
//  항목과 옆 창은 접혀 있어도 숨긴 채 붙여 둔다 — 칸들의 조회·상태 줄이 열기 전에도 돈다.
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
const groupOf = (title: string) => [...float().querySelectorAll<HTMLElement>(".settings-group")].find((group) => group.querySelector(".settings-group-title")!.textContent === title)!;
const items = (title: string) => [...groupOf(title).querySelectorAll<HTMLElement>(".settings-fold")];
const titleOf = (item: HTMLElement) => item.querySelector(".settings-fold-title")!.textContent;
const summaryOf = (item: HTMLElement) => item.querySelector(".settings-fold-summary")?.textContent;
const panelOf = (item: HTMLElement) => document.getElementById(item.querySelector(".settings-fold-head")!.getAttribute("aria-controls")!)!;
const sectionsOf = (item: HTMLElement) => [...panelOf(item).querySelectorAll(".settings-group-content > .settings-section > h4")].map((h) => h.textContent);
const subOf = (title: string) => document.getElementById(groupOf(title).querySelector(".settings-group-toggle")!.getAttribute("aria-controls")!)!;
const openGroup = (title: string) => act(() => {
  groupOf(title).querySelector<HTMLButtonElement>(".settings-group-toggle")!.click();
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

it("설정 창 — 처음엔 두 묶음 + MV Hub Update, 묶음을 누르면 그 밑으로 펼치고 항목마다 옆 창에 칸이 제자리에 있다", async () => {
  await act(async () => root.render(<SettingsPanel onClose={() => {}} onOpenMcp={() => {}} />));
  expect([...float().querySelectorAll(".settings-group-title")].map((title) => title.textContent)).toEqual(["기본 설정", "외부 프로그램"]);
  expect([...float().querySelectorAll(".settings-group-summary")].map((line) => line.textContent))
    .toEqual(["화면 · 작업 · 자료 관리", "Slack · ComfyUI · DaVinci Resolve · MCP"]);
  expect([subOf("기본 설정").hidden, subOf("외부 프로그램").hidden]).toEqual([true, true]); // 처음엔 둘 다 접힘
  // 맨 아래 업데이트 — 제목 없이 단추 하나(새 버전 확인 전엔 회색 'MV Hub Update')
  expect(float().querySelectorAll(".admin-body > .settings-section > h4")).toHaveLength(0);
  const update = float().querySelector<HTMLButtonElement>(".settings-update .release-update-action")!;
  expect([update.textContent, update.classList.contains("is-update-available"), update.disabled]).toEqual(["MV Hub Update", false, true]);
  expect(float().lastElementChild!.lastElementChild!.classList.contains("settings-update")).toBe(true);
  expect(document.querySelectorAll(".settings-group-flyout:not([hidden])")).toHaveLength(0); // 옆 창은 숨긴 채

  openGroup("기본 설정");
  const basic = groupOf("기본 설정");
  expect([basic.classList.contains("is-open"), subOf("기본 설정").hidden, basic.querySelector(".settings-group-summary")])
    .toEqual([true, false, null]); // 펼치면 그 밑 상자가 보이고 항목 이름 줄은 빠진다
  expect(subOf("외부 프로그램").hidden).toBe(true);
  expect(items("기본 설정").map(titleOf)).toEqual(["화면", "작업", "자료 관리"]);
  expect(items("기본 설정").map((item) => panelOf(item).hidden)).toEqual([true, true, true]);
  expect(items("기본 설정").map(sectionsOf)).toEqual([
    ["강조색", "언어 · Language", "모션", "필터 테마"],
    ["다운로드 위치", "단축키"],
    [], // 자료 관리는 칸 제목 없이 숫자 요약부터(시안 v3)
  ]);
  // 자료 관리 = 숫자 요약 → [지금 백업][서버 백업 가져오기] → 생성물 점검 → '백업 자동 설정 · 고급'(보관 설정·서버 백업 고르기·DB 파일·과거 생성물)
  const data = panelOf(items("기본 설정")[2]);
  expect([...data.querySelectorAll(".settings-tile-label")].map((label) => label.textContent)).toEqual(["백업", "복원 보류", "전송 대기"]);
  expect([...data.querySelectorAll(".settings-backup > .settings-row")].map((line) => [...line.querySelectorAll(".settings-action")].map((b) => b.textContent)))
    .toEqual([["지금 백업", "서버 백업 가져오기"], ["재점검", "HF 생성물", "HF 삭제물"]]);
  expect([...data.querySelectorAll(".settings-mini-title")].map((h) => h.textContent)).toEqual(["생성물 점검"]); // 파일로 주고받기는 캔버스 저장소가 열린 창에서만
  const advanced = data.querySelector<HTMLDetailsElement>(".settings-backup > details.settings-adv")!;
  expect([advanced.open, advanced.querySelector("summary")!.textContent]).toEqual([false, "백업 자동 설정 · 고급 사진 찍는 때 · 남기는 양 · 파일로 직접 주고받기"]);
  expect([...advanced.querySelectorAll(".settings-subblock > h6")].map((h) => h.textContent))
    .toEqual(["다른 PC·서버 백업 고르기", "서버 없이 파일로 직접 주고받기", "과거 생성물"]);
  expect(summaryOf(items("기본 설정")[0])).toBe("한글 · 모션 ON · 필터 기본");
  expect(items("기본 설정")[0].querySelector(".settings-fold-dot")).not.toBeNull(); // 강조색 점

  // 항목을 누르면 그 옆 창만 — 다른 항목을 누르면 옆 창이 그 항목으로 바뀐다
  openItem(items("기본 설정")[0]);
  expect(items("기본 설정").map((item) => panelOf(item).hidden)).toEqual([false, true, true]);
  expect(items("기본 설정").map((item) => item.classList.contains("is-open"))).toEqual([true, false, false]);
  openItem(items("기본 설정")[2]);
  expect(items("기본 설정").map((item) => panelOf(item).hidden)).toEqual([true, true, false]);

  // 묶음을 접으면 그 안 항목의 옆 창도 닫힌다
  openGroup("기본 설정");
  expect([subOf("기본 설정").hidden, panelOf(items("기본 설정")[2]).hidden]).toEqual([true, true]);
  expect(groupOf("기본 설정").querySelector(".settings-group-summary")!.textContent).toBe("화면 · 작업 · 자료 관리");

  openGroup("외부 프로그램");
  expect(items("외부 프로그램").map(titleOf)).toEqual(["Slack 알림", "ComfyUI", "DaVinci Resolve", "MV·MCP 연결"]);
  expect(items("외부 프로그램").map((item) => panelOf(item).hidden)).toEqual([true, true, true, true]);
  expect(sectionsOf(items("외부 프로그램")[1])).toEqual(["ComfyUI", "미회수 실행"]); // ComfyUI 제목은 CSS 로 숨긴다(hide-first-title)
  expect(items("외부 프로그램").map((item) => panelOf(item).classList.contains("hide-first-title"))).toEqual([true, true, true, true]);
  // DaVinci = 연결 상자 → 설치 목록(MV Resolve 는 상태를 받은 뒤에, Script 는 늘) → 실시간 체크 스위치
  const resolve = panelOf(items("외부 프로그램")[2]);
  expect(resolve.querySelector(".settings-conn")).not.toBeNull();
  expect([...resolve.querySelectorAll(".settings-install-name")].map((name) => name.textContent)).toEqual(["MV Resolve", "Script"]);
  expect(resolve.querySelector(".settings-switch input[role=switch]")).not.toBeNull();
  // MV·MCP 연결 = 앱 세 줄 + [한 번에 연결]
  const mcp = panelOf(items("외부 프로그램")[3]);
  expect([...mcp.querySelectorAll(".settings-install-name")].map((name) => name.textContent)).toEqual(["Codex", "Claude Code", "Claude 데스크톱 채팅"]);
  expect(mcp.querySelector(".settings-action-main")!.textContent).toBe("한 번에 연결");
});

it("설정 창 — 넘겨받은 자리(아바타 바로 밑, 프로필 메뉴와 같은 자리)에 뜬다 · 없으면 CSS 기본 자리", async () => {
  await act(async () => root.render(<SettingsPanel onClose={() => {}} anchor={{ top: 64, right: 380 }} />));
  expect([float().style.top, float().style.right, float().style.maxHeight]).toEqual(["64px", "380px", "calc(100vh - 72px)"]);
  await act(async () => root.render(<SettingsPanel onClose={() => {}} />));
  expect([float().style.top, float().style.right]).toEqual(["", ""]);
});

it("설정 창 — MV·MCP 연결을 넘겨받지 않은 창에는 그 항목이 없다", async () => {
  await act(async () => root.render(<SettingsPanel onClose={() => {}} />));
  expect(float().querySelectorAll(".settings-group-summary")[1].textContent).toBe("Slack · ComfyUI · DaVinci Resolve");
  openGroup("외부 프로그램");
  expect(items("외부 프로그램").map(titleOf)).toEqual(["Slack 알림", "ComfyUI", "DaVinci Resolve"]);
});

it("MV Hub Update — [다시 확인]은 새로 고침 아이콘 단추(이름은 title·aria-label), 단추 앞 그림 기호가 없다", async () => {
  await act(async () => root.render(<SettingsPanel onClose={() => {}} />));
  const refresh = document.querySelector<HTMLButtonElement>(".release-update-refresh")!;
  expect([refresh.title, refresh.getAttribute("aria-label"), refresh.textContent, !!refresh.querySelector("svg")]).toEqual(["다시 확인", "다시 확인", "", true]);
  openGroup("기본 설정");
  const labels = [...document.querySelectorAll<HTMLElement>(".settings-float .settings-action, .settings-group-flyout .settings-action")]
    .filter((button) => !button.closest(".settings-help-content")) // 더보기 안 강제 업데이트(⚠)는 경고 표시 그대로
    .map((button) => button.textContent ?? "");
  expect(labels.filter((label) => /^[^\p{L}\p{N}]/u.test(label.trim()) && label.trim())).toEqual([]);
});
