// @vitest-environment jsdom
// 완료 탭 레이아웃(2026-09-21 Jay 확정: 위 = 한 장의 판 · 아래 = 저장 대상 | 저장 이력) — 프로젝트 고르기는 머리글이 아니라 판 안에 있고,
// 저장 대상 목록이 줄마다 새로 저장·이미 저장·저장 불가(사유)를, 저장 이력은 렌더 폴더 아래 경로만 보여 준다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ExportView } from "../src/components/manage/ExportView";
import type { SaveFinalsStatus } from "../src/lib/manageApi";

let status: SaveFinalsStatus;
vi.mock("../src/api", () => ({ api: { projects: async () => ({ projects: [{ id: "p1", name: "fixture" }] }) } }));
vi.mock("../src/lib/manageApi", () => ({ manageApi: { saveFinalsStatus: async () => status, saveFinals: vi.fn() } }));
const target = (gen_id: string, saved: boolean, reason: string | null, filename = gen_id + ".mp4") => ({ gen_id, folder_path: "ep001/" + gen_id, filename, saved, reason });
let root: Root, host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const mount = async () => { await act(async () => { root.render(<ExportView />); }); await act(async () => {}); };
const texts = (selector: string) => [...host.querySelectorAll(selector)].map((element) => element.textContent);

it("프로젝트 고르기는 판 안에 있고, 저장 대상 줄마다 상태와 사유가 붙는다", async () => {
  status = { render_path: "R:/render/", error: null, targets: [target("c0030", false, null), target("c0010", true, null), target("c0050", false, "원본 파일 없음", "")],
    history: [{ gen_id: "h1", dest_path: "R:/render/ep001/c0010/c0010.mp4", exported_at: "2026-09-18 14:02", exists: true }, { gen_id: "h2", dest_path: "Z:/other/x.mp4", exported_at: "2026-09-18 14:02", exists: false }] };
  await mount();
  expect(host.querySelector(".manage-head select")).toBeNull();
  expect(host.querySelector(".export-card select.manage-proj-select")).not.toBeNull();
  expect(texts(".export-counts b")).toEqual(["1", "1", "1"]);
  expect(texts(".export-target-list .export-badge")).toEqual(["새로 저장", "이미 저장", "저장 불가"]);
  expect(texts(".export-target-list code")).toEqual(["ep001/c0030 · c0030.mp4", "ep001/c0010 · c0010.mp4", "ep001/c0050"]);
  expect(texts(".export-target-reason")).toEqual(["원본 파일 없음"]);
  expect(texts(".export-side .export-history-list:not(.export-target-list) code")).toEqual(["ep001/c0010/c0010.mp4", "Z:/other/x.mp4"]); // 렌더 폴더 밖이면 전체 경로 그대로
  expect(host.querySelector(".export-history-list:not(.export-target-list) code")!.getAttribute("title")).toBe("R:/render/ep001/c0010/c0010.mp4");
  expect(host.querySelector<HTMLButtonElement>(".export-btn")!.textContent).toBe("완료만 저장하기 (1)");
});

it("구버전 서버라 대상을 알 수 없을 때는 '저장할 최종본이 없습니다' 라고 말하지 않는다", async () => {
  status = { render_path: "R:/render", error: null, server_outdated: true, targets: [], history: [] };
  await mount();
  expect(host.querySelector(".export-side")!.textContent).not.toContain("저장할 최종본이 없습니다");
  expect(host.querySelector<HTMLButtonElement>(".export-btn")!.disabled).toBe(true);
  status = { render_path: "R:/render", error: null, targets: [], history: [] };
  act(() => root.unmount()); root = createRoot(host);
  await mount();
  expect(host.querySelector(".export-side")!.textContent).toContain("저장할 최종본이 없습니다");
});
