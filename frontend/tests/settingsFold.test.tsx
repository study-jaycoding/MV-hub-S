// @vitest-environment jsdom
// 설정 창 시안 F(Jay 2026-11-06 "F안으로") — 바깥엔 [기본 설정][외부 프로그램] + MV 업데이트만, 옆 패널 안은 처음엔 접힌 큰 묶음.
//  묶음 제목 밑 상태 줄은 접어 둬도 보인다("실시간 정보는 접기 밖", Jay 08-20). 본문은 붙여 둔 채 hidden — 칸들의 조회가 펼치기 전에도 돈다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// 가짜는 바깥 경계(서버 호출)에만 — 응답은 '아직 안 옴'(창의 틀과 묶음은 응답 없이도 그려진다)
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

const folds = () => [...document.querySelectorAll<HTMLElement>(".settings-group-flyout .settings-fold")];
const titleOf = (fold: HTMLElement) => fold.querySelector(".settings-fold-title")!.textContent;
const summaryOf = (fold: HTMLElement) => fold.querySelector(".settings-fold-summary")?.textContent;
const sectionsOf = (fold: HTMLElement) => [...fold.querySelectorAll(".settings-fold-body > .settings-section > h4")].map((h) => h.textContent);
const openGroup = (title: string) => act(() => {
  [...document.querySelectorAll<HTMLButtonElement>(".settings-group-toggle")].find((button) => button.textContent?.includes(title))!.click();
});

it("접는 묶음 — 처음엔 접혀 있고(본문은 붙어 있고 hidden) 제목 밑 줄은 보인다 · 누르면 펼치고 다시 누르면 접는다", () => {
  act(() => root.render(<SettingsFold title="묶음" summary="지금 상태"><button type="button">안쪽</button></SettingsFold>));
  const head = host.querySelector<HTMLButtonElement>(".settings-fold-head")!;
  const body = host.querySelector<HTMLElement>(".settings-fold-body")!;
  expect([head.getAttribute("aria-expanded"), body.hidden, body.textContent, host.querySelector(".settings-fold-summary")?.textContent])
    .toEqual(["false", true, "안쪽", "지금 상태"]);
  expect(head.getAttribute("aria-controls")).toBe(body.id);
  act(() => head.click());
  expect([head.getAttribute("aria-expanded"), body.hidden, host.querySelector(".settings-fold")!.classList.contains("is-open")]).toEqual(["true", false, true]);
  act(() => head.click());
  expect([head.getAttribute("aria-expanded"), body.hidden]).toEqual(["false", true]);
});

it("접는 묶음 — 상태 줄이 비면 그 줄을 그리지 않는다", () => {
  act(() => root.render(<SettingsFold title="묶음" summary=""><p>안쪽</p></SettingsFold>));
  expect(host.querySelector(".settings-fold-summary")).toBeNull();
});

it("설정 창 — 바깥엔 두 묶음 + MV 업데이트만, 옆 패널은 시안 F 순서의 접힌 묶음이고 칸이 제자리에 있다", async () => {
  await act(async () => root.render(<SettingsPanel onClose={() => {}} onOpenMcp={() => {}} />));
  const float = document.querySelector<HTMLElement>(".settings-float")!;
  expect([...float.querySelectorAll(".settings-group-toggle")].map((button) => button.textContent?.replace("‹", "").trim()))
    .toEqual(["기본 설정", "외부 프로그램"]);
  expect([...float.querySelectorAll(".admin-body > .settings-section > h4")].map((h) => h.textContent)).toEqual(["MV 업데이트"]);

  openGroup("기본 설정");
  expect(folds().map(titleOf)).toEqual(["화면", "작업", "자료 관리"]);
  expect(folds().map((fold) => fold.querySelector<HTMLElement>(".settings-fold-body")!.hidden)).toEqual([true, true, true]);
  // 캔버스 자료 칸은 캔버스 저장소가 열린 창에서만 그린다(시험에는 저장소가 없다) — 그 밖의 칸은 모두 제 묶음에
  expect(folds().map(sectionsOf)).toEqual([
    ["강조색", "언어 · Language", "모션", "필터 테마"],
    ["다운로드 위치", "단축키"],
    ["메타데이터", "생성물 재점검"],
  ]);
  expect(summaryOf(folds()[0])).toBe("한글 · 모션 ON · 필터 기본");
  expect(folds()[0].querySelector(".settings-fold-dot")).not.toBeNull(); // 강조색 점

  openGroup("외부 프로그램");
  expect(folds().map(titleOf)).toEqual(["Slack 알림", "ComfyUI", "DaVinci Resolve", "MV·MCP 연결"]);
  expect(folds().map((fold) => fold.querySelector<HTMLElement>(".settings-fold-body")!.hidden)).toEqual([true, true, true, true]);
  expect(sectionsOf(folds()[1])).toEqual(["ComfyUI", "미회수 실행"]); // ComfyUI 제목은 CSS 로 숨긴다(hide-first-title)
  expect(folds().map((fold) => fold.classList.contains("hide-first-title"))).toEqual([true, true, true, true]);
  expect(summaryOf(folds()[3])).toBe("Codex·Claude Code 연결");
});

it("설정 창 — MV·MCP 연결을 넘겨받지 않은 창에는 그 묶음이 없다", async () => {
  await act(async () => root.render(<SettingsPanel onClose={() => {}} />));
  openGroup("외부 프로그램");
  expect(folds().map(titleOf)).toEqual(["Slack 알림", "ComfyUI", "DaVinci Resolve"]);
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
