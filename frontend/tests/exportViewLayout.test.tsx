// @vitest-environment jsdom
// 완료 탭(2026-09-21 Jay 확정: 위 = 한 장의 판 · 아래 = 저장 대상 | 저장 이력) — 프로젝트 고르기는 머리글이 아니라 판 안에 있고,
// 저장은 공유 저장 · 최종 저장(골드) 두 단추로 나뉜다. 저장 대상은 씬별로 묶은 격자선 표(구분·컷·파일 이름·종류·상태·저장한 때)이고 거르기 단추가 붙는다. 이력은 렌더 폴더 아래 경로만 보여 준다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ExportView } from "../src/components/manage/ExportView";
import type { SaveFinalsKind, SaveFinalsStatus } from "../src/lib/manageApi";

let status: SaveFinalsStatus;
const saveFinals = vi.hoisted(() => vi.fn());
const saveFinalsCompare = vi.hoisted(() => vi.fn());
const saveFinalsMirror = vi.hoisted(() => vi.fn());
vi.mock("../src/api", () => ({ api: { projects: async () => ({ projects: [{ id: "p1", name: "fixture" }] }) } }));
vi.mock("../src/lib/manageApi", () => ({ manageApi: { saveFinalsStatus: async () => status, saveFinals, saveFinalsCompare, saveFinalsMirror } }));
const target = (gen_id: string, saved: boolean, reason: string | null, kind: SaveFinalsKind = "final", filename = gen_id + ".mp4") => ({ gen_id, kind, folder_path: "ep001/" + gen_id, filename, saved, reason });
let root: Root, host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  saveFinals.mockReset().mockResolvedValue({ saved: 1, skipped: 0, errors: [] });
  saveFinalsCompare.mockReset();
  saveFinalsMirror.mockReset();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const mount = async () => { await act(async () => { root.render(<ExportView />); }); await act(async () => {}); };
const texts = (selector: string) => [...host.querySelectorAll(selector)].map((element) => element.textContent);
// 확인 창의 단추 — 단추 다섯 개 모두 "~하시겠습니까? 예/아니오"를 거친다(Jay 2026-09-21)
const answer = async (label: "예" | "아니오") => { await act(async () => { [...host.querySelectorAll<HTMLButtonElement>(".export-modal button")].find((item) => item.textContent!.startsWith(label))!.click(); }); };
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>(".export-act button")].find((item) => item.textContent!.startsWith(label))!;

it("프로젝트 고르기는 판 안에 있고, 저장 대상은 씬별로 묶인 표에 종류·상태·사유가 붙는다", async () => {
  status = { render_path: "\\\\NAS\\proj\\Render", error: null, shared_supported: true,
    targets: [target("c0030", false, null), { ...target("c0010", true, null), saved_at: "2026-09-18 05:02:00" }, target("c0050", false, "원본 파일 없음", "final", ""), target("c0040", false, null, "shared", "c0040.png"), { ...target("s0010", false, null, "shared"), folder_path: "ep002/sq01/s0010" }],
    history: [{ gen_id: "h1", dest_path: "\\\\NAS\\proj\\Render\\ep001\\c0010\\c0010.mp4", exported_at: "2026-09-18 14:02", exists: true }, { gen_id: "h2", dest_path: "Z:/other/x.mp4", exported_at: "2026-09-18 14:02", exists: false }] };
  await mount();
  expect(host.querySelector(".manage-head select")).toBeNull();
  expect(host.querySelector(".export-card select.manage-proj-select")).not.toBeNull();
  expect(texts(".export-counts b")).toEqual(["1", "1", "2", "0", "1"]); // 최종(새로·이미) · 공유(새로·이미) · 저장 불가
  // 씬(폴더의 앞부분)별 묶음 줄 → 그 안은 컷 순서. 컷 = 폴더의 마지막 마디.
  expect(texts(".export-group td")).toEqual(["ep0014개", "ep002/sq011개"]);
  expect(texts(".export-table tbody tr:not(.export-group) td:nth-child(2)")).toEqual(["c0010", "c0030", "c0040", "c0050", "s0010"]);
  expect(texts(".export-table .export-badge:not([class*=kind-])")).toEqual(["이미 저장", "새로 저장", "새로 저장", "저장 불가", "새로 저장"]);
  expect(texts(".export-table .export-badge[class*=kind-]")).toEqual(["최종", "최종", "공유", "최종", "공유"]);
  expect(texts(".export-table code")).toEqual(["c0010.mp4", "c0030.mp4", "c0040.png", "c0050", "s0010.mp4"]);
  expect(texts(".export-table tbody tr:not(.export-group) td:nth-child(4)")).toEqual(["영상", "영상", "이미지", "—", "영상"]);
  const when = texts(".export-table tbody tr:not(.export-group) td:nth-child(6)");
  expect(when.slice(1)).toEqual(["—", "—", "—", "—"]);
  expect(when[0]).not.toBe("—"); // 저장 대장의 시각(UTC)을 이 PC 의 시각으로 보여 준다
  expect(when[0]).not.toContain("05:02");
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
  expect(host.querySelector(".export-modal h3")!.textContent).toBe("공유본 2개를 저장하시겠습니까?");
  expect(texts(".export-modal button")).toEqual(["예", "아니오"]); // 단추 순서 = 예 · 아니오(Jay 2026-09-21)
  expect(saveFinals).not.toHaveBeenCalled(); // 단추를 눌렀다고 바로 저장하지 않는다
  await answer("아니오");
  expect(host.querySelector(".export-modal")).toBeNull();
  expect(saveFinals).not.toHaveBeenCalled();
  await act(async () => { button("공유 저장").click(); });
  await answer("예");
  expect(saveFinals).toHaveBeenLastCalledWith("p1", undefined, "shared");
  await act(async () => { button("최종 저장").click(); });
  expect(host.querySelector(".export-modal h3")!.textContent).toBe("최종본 1개를 저장하시겠습니까?");
  await answer("예");
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

it("비교를 실행해야 미러·업데이트가 켜지고, 저장하면 다시 꺼진다", async () => {
  status = { render_path: "R:/render", error: null, shared_supported: true, targets: [target("c0030", false, null), target("c0040", false, null, "shared")], history: [] };
  saveFinalsCompare.mockResolvedValue({ shared_supported: true, same: 3, unknown: 2, blocked: [],
    to_add: [{ gen_id: "c0030", kind: "final", folder_path: "ep001/c0030", filename: "c0030.mp4" }, { gen_id: "c0040", kind: "shared", folder_path: "ep001/c0040/shared", filename: "c0040.mp4" }],
    extra: [{ gen_id: "old", kind: "final", folder_path: "ep001/c0010", filename: "c0010_old.mp4" }] });
  await mount();
  const compareButton = () => host.querySelector<HTMLButtonElement>(".export-icon-btn")!;
  expect(button("업데이트").disabled).toBe(true);
  expect(button("업데이트").title).toContain("비교를 먼저");
  expect(button("미러").disabled).toBe(true);
  expect(host.querySelector(".export-hint-two")!.textContent).toBe("미러 - 실시간 동기화 (삭제 및 변경 가능)업데이트 - 추가분 누적 동기화");
  await act(async () => { compareButton().click(); });
  expect(host.querySelector(".export-modal h3")!.textContent).toBe("프로그램과 렌더 폴더를 비교하시겠습니까?");
  expect(saveFinalsCompare).not.toHaveBeenCalled();
  await answer("예");
  expect(saveFinalsCompare).toHaveBeenCalledWith("p1");
  expect(compareButton().classList.contains("on")).toBe(true);
  expect(button("업데이트").textContent).toBe("업데이트 (+2)");
  expect(button("업데이트").disabled).toBe(false);
  expect(button("미러").textContent).toBe("미러 (+2 · −1)");
  expect(button("미러").disabled).toBe(false);
  expect(texts(".export-pill")).toEqual(["새로 저장할 것 2", "폴더에만 남은 것 1", "같음 3", "모르는 파일 2 · 건드리지 않음"]);
  expect(texts(".export-compare code")).toEqual(["ep001/c0030 · c0030.mp4", "ep001/c0040/shared · c0040.mp4", "ep001/c0010 · c0010_old.mp4"]);
  await act(async () => { button("업데이트").click(); });
  expect(host.querySelector(".export-modal h3")!.textContent).toBe("새로 추가된 2개를 올리시겠습니까?");
  await answer("예");
  expect(saveFinals).toHaveBeenLastCalledWith("p1", undefined, "all");
  expect(host.querySelector(".export-compare")).toBeNull(); // 폴더가 달라졌다 — 낡은 비교는 버린다
  expect(button("업데이트").disabled).toBe(true);
});

it("미러는 확인 창에서 본 목록을 그대로 보내고, 정리가 너무 많다는 답이 오면 한 번 더 묻는다", async () => {
  status = { render_path: "R:/render", error: null, shared_supported: true, targets: [target("c0030", false, null)], history: [] };
  const extra = [{ gen_id: "old1", kind: "final" as const, folder_path: "ep001/c0010", filename: "c0010_old.mp4" }, { gen_id: "old2", kind: "shared" as const, folder_path: "ep001/c0020/shared", filename: "c0020_old.mp4" }];
  saveFinalsCompare.mockResolvedValue({ shared_supported: true, same: 1, unknown: 3, blocked: [], to_add: [{ gen_id: "c0030", kind: "final", folder_path: "ep001/c0030", filename: "c0030.mp4" }], extra });
  const { HttpError } = await import("../src/lib/http");
  saveFinalsMirror.mockRejectedValueOnce(new HttpError(409, "정리할 파일(2개)이 남는 파일(1개)보다 많습니다."))
    .mockResolvedValue({ saved: 1, skipped: 0, errors: [], moved: [{ folder_path: "ep001/c0010", filename: "c0010_old.mp4" }], skipped_recent: 1, quarantine: "_mvhub_removed/2026-09-21_143200_ab12cd34" });
  await mount();
  await act(async () => { host.querySelector<HTMLButtonElement>(".export-icon-btn")!.click(); });
  await answer("예");
  expect(host.querySelector(".export-modal")).toBeNull();
  await act(async () => { button("미러").click(); });
  const modal = () => host.querySelector(".export-modal")!;
  expect(modal().textContent).toContain("지우지 않고");
  expect(modal().textContent).toContain("모르는 파일 3개는 건드리지 않습니다");
  expect([...modal().querySelectorAll("code.export-history-path")].map((item) => item.textContent)).toEqual(["ep001/c0010 · c0010_old.mp4", "ep001/c0020/shared · c0020_old.mp4"]);
  expect(saveFinalsMirror).not.toHaveBeenCalled(); // 단추를 눌렀다고 바로 옮기지 않는다
  expect(modal().querySelector("h3")!.textContent).toBe("렌더 폴더를 프로그램과 똑같이 맞추시겠습니까?");
  // 문구는 단추에서 떼어 단추 바로 앞에 둔다(Jay 2026-09-21 A안) — 단추에는 "예"만, 순서는 문구 · 예 · 아니오
  const go = () => [...modal().querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === "예")!;
  expect([...modal().querySelector(".export-modal-btns")!.children].map((item) => item.textContent)).toEqual(["2개 옮기고 1개 저장", "예", "아니오"]);
  await act(async () => { go().click(); });
  expect(saveFinalsMirror).toHaveBeenLastCalledWith("p1", extra.map(({ folder_path, filename }) => ({ folder_path, filename })), false);
  expect(modal().textContent).toContain("정리할 파일이 남는 파일보다 많습니다"); // 서버의 재확인 요청 — 창을 다시 띄운다
  await act(async () => { go().click(); });
  expect(saveFinalsMirror).toHaveBeenLastCalledWith("p1", expect.any(Array), true);
  expect(host.querySelector(".export-modal")).toBeNull();
  expect(host.querySelector(".export-result")!.textContent).toContain("정리 1");
  expect(host.querySelector(".export-result")!.textContent).toContain("_mvhub_removed/2026-09-21_143200_ab12cd34");
  expect(host.querySelector(".export-result")!.textContent).toContain("방금 쓰인 파일 1개는 옮기지 않았습니다");
  expect(button("미러").disabled).toBe(true); // 폴더가 달라졌다 — 다시 비교해야 켜진다
});

it("미러 창에서 아니오를 누르면 아무것도 보내지 않는다", async () => {
  status = { render_path: "R:/render", error: null, shared_supported: true, targets: [], history: [] };
  saveFinalsCompare.mockResolvedValue({ shared_supported: true, same: 1, unknown: 0, blocked: [], to_add: [], extra: [{ gen_id: "old1", kind: "final", folder_path: "ep001/c0010", filename: "c0010_old.mp4" }] });
  await mount();
  await act(async () => { host.querySelector<HTMLButtonElement>(".export-icon-btn")!.click(); });
  await answer("예");
  await act(async () => { button("미러").click(); });
  await answer("아니오");
  expect(host.querySelector(".export-modal")).toBeNull();
  expect(saveFinalsMirror).not.toHaveBeenCalled();
});

it("거르기 단추는 하나만 켜지고, 고른 종류·상태의 줄만 남긴다", async () => {
  status = { render_path: "R:/render", error: null, shared_supported: true, history: [],
    targets: [target("c0030", false, null), target("c0010", true, null), target("c0050", false, "원본 파일 없음"), target("c0040", false, null, "shared")] };
  await mount();
  const chip = (label: string) => [...host.querySelectorAll<HTMLButtonElement>(".export-filter")].find((item) => item.textContent!.startsWith(label))!;
  expect(texts(".export-filter")).toEqual(["전체 4", "★ 최종 3", "공유 1", "새로 저장 2", "이미 저장 1", "저장 불가 1"]);
  expect(chip("전체").getAttribute("aria-pressed")).toBe("true");
  await act(async () => { chip("공유").click(); });
  expect(texts(".export-table code")).toEqual(["c0040.mp4"]);
  expect(chip("전체").getAttribute("aria-pressed")).toBe("false");
  await act(async () => { chip("저장 불가").click(); });
  expect(texts(".export-table code")).toEqual(["c0050.mp4"]);
  await act(async () => { chip("이미 저장").click(); });
  expect(texts(".export-table code")).toEqual(["c0010.mp4"]);
  expect(host.querySelector(".export-side")!.classList.contains("two")).toBe(false); // 이력이 없으면 표가 가로 전체를 쓴다
});
