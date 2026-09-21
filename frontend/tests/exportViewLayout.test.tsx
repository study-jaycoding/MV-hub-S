// @vitest-environment jsdom
// 완료 탭(2026-09-21 Jay 확정: 위 = 한 장의 판 · 아래 = 저장 대상 | 저장 이력) — 프로젝트 고르기는 머리글이 아니라 판 안에 있고,
// 저장은 공유 저장 · 최종 저장(골드) 두 단추로 나뉜다. 저장 대상은 줄마다 종류·상태·저장 불가 사유를, 이력은 렌더 폴더 아래 경로만 보여 준다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ExportView } from "../src/components/manage/ExportView";
import type { SaveFinalsKind, SaveFinalsStatus } from "../src/lib/manageApi";

let status: SaveFinalsStatus;
const saveFinals = vi.hoisted(() => vi.fn());
vi.mock("../src/api", () => ({ api: { projects: async () => ({ projects: [{ id: "p1", name: "fixture" }] }) } }));
vi.mock("../src/lib/manageApi", () => ({ manageApi: { saveFinalsStatus: async () => status, saveFinals } }));
const target = (gen_id: string, saved: boolean, reason: string | null, kind: SaveFinalsKind = "final", filename = gen_id + ".mp4") => ({ gen_id, kind, folder_path: "ep001/" + gen_id, filename, saved, reason });
let root: Root, host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  saveFinals.mockReset().mockResolvedValue({ saved: 1, skipped: 0, errors: [] });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const mount = async () => { await act(async () => { root.render(<ExportView />); }); await act(async () => {}); };
const texts = (selector: string) => [...host.querySelectorAll(selector)].map((element) => element.textContent);
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>(".export-act button")].find((item) => item.textContent!.startsWith(label))!;

it("프로젝트 고르기는 판 안에 있고, 저장 대상 줄마다 종류·상태·사유가 붙는다", async () => {
  status = { render_path: "\\\\NAS\\proj\\Render", error: null, shared_supported: true,
    targets: [target("c0030", false, null), target("c0010", true, null), target("c0050", false, "원본 파일 없음", "final", ""), target("c0040", false, null, "shared"), target("c0041", false, null, "shared")],
    history: [{ gen_id: "h1", dest_path: "\\\\NAS\\proj\\Render\\ep001\\c0010\\c0010.mp4", exported_at: "2026-09-18 14:02", exists: true }, { gen_id: "h2", dest_path: "Z:/other/x.mp4", exported_at: "2026-09-18 14:02", exists: false }] };
  await mount();
  expect(host.querySelector(".manage-head select")).toBeNull();
  expect(host.querySelector(".export-card select.manage-proj-select")).not.toBeNull();
  expect(texts(".export-counts b")).toEqual(["1", "1", "2", "0", "1"]); // 최종(새로·이미) · 공유(새로·이미) · 저장 불가
  expect(texts(".export-target-list .export-badge:not([class*=kind-])")).toEqual(["새로 저장", "이미 저장", "저장 불가", "새로 저장", "새로 저장"]);
  expect(texts(".export-target-list .export-badge[class*=kind-]")).toEqual(["최종", "최종", "최종", "공유", "공유"]);
  expect(texts(".export-target-list code")).toEqual(["ep001/c0030 · c0030.mp4", "ep001/c0010 · c0010.mp4", "ep001/c0050", "ep001/c0040/shared · c0040.mp4", "ep001/c0041/shared · c0041.mp4"]);
  expect(texts(".export-target-reason")).toEqual(["원본 파일 없음"]);
  // 이력은 렌더 폴더 아래 부분만 — 윈도우 경로(역슬래시)에서도 앞의 구분자가 남지 않는다. 렌더 폴더 밖이면 전체 경로 그대로.
  expect(texts(".export-side .export-history-list:not(.export-target-list) code")).toEqual(["ep001\\c0010\\c0010.mp4", "Z:/other/x.mp4"]);
  expect(host.querySelector(".export-history-list:not(.export-target-list) code")!.getAttribute("title")).toBe("\\\\NAS\\proj\\Render\\ep001\\c0010\\c0010.mp4");
});

it("공유 저장과 최종 저장은 각자의 종류로만 저장을 부른다", async () => {
  status = { render_path: "R:/render", error: null, shared_supported: true, targets: [target("c0030", false, null), target("c0040", false, null, "shared"), target("c0041", false, null, "shared")], history: [] };
  await mount();
  expect(button("공유 저장").textContent).toBe("공유 저장 (2)");
  expect(button("최종 저장").textContent).toBe("최종 저장 (1)");
  expect(button("최종 저장").classList.contains("export-btn-final")).toBe(true);
  await act(async () => { button("공유 저장").click(); });
  expect(saveFinals).toHaveBeenLastCalledWith("p1", undefined, "shared");
  await act(async () => { button("최종 저장").click(); });
  expect(saveFinals).toHaveBeenLastCalledWith("p1", undefined, "final");
});

it("공유 서버가 구버전이면 공유 저장만 꺼지고 최종 저장은 그대로 된다", async () => {
  status = { render_path: "R:/render", error: null, shared_supported: false, targets: [target("c0030", false, null)], history: [] };
  await mount();
  expect(button("공유 저장").disabled).toBe(true);
  expect(button("공유 저장").title).toContain("공유 서버 업데이트");
  expect(button("최종 저장").disabled).toBe(false);
});

it("구버전 서버라 대상을 알 수 없을 때는 '저장할 최종본이 없습니다' 라고 말하지 않는다", async () => {
  status = { render_path: "R:/render", error: null, server_outdated: true, targets: [], history: [] };
  await mount();
  expect(host.querySelector(".export-side")!.textContent).not.toContain("저장할 최종본이 없습니다");
  expect(button("최종 저장").disabled).toBe(true);
  status = { render_path: "R:/render", error: null, targets: [], history: [] };
  act(() => root.unmount()); root = createRoot(host);
  await mount();
  expect(host.querySelector(".export-side")!.textContent).toContain("저장할 최종본이 없습니다");
});
