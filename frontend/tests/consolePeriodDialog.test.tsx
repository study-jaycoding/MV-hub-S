// @vitest-environment jsdom
// 서브스페이스 '프로젝트 기간' 창(2026-10-03 점검 CXF-1) — 저장의 기준값은 **창을 열 때 읽은 기획**이어야 한다.
// 저장 직전에 다시 읽어 그 revision 에 옛 화면 날짜를 붙이면, 그사이 다른 관리자가 바꾼 날짜를 충돌 없이 덮는다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Planning } from "../src/components/manage/types";

const getPlanning = vi.fn();
vi.mock("../src/lib/manageApi", () => ({ manageApi: { getPlanning: (pid: string) => getPlanning(pid) } }));

const { ConsolePeriodDialog } = await import("../src/components/manage/console/ConsolePeriodDialog");

const SUB = {
  id: "ws-sub", name: "서브 A",
  projects: [{ id: "p1", name: "프로젝트 1", archived: false, start_date: "2026-10-01", due_date: "2026-10-31" }],
} as never;

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  getPlanning.mockReset();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); }); };
const typeDate = async (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => { setter?.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
};
const saveButton = () => [...host.querySelectorAll<HTMLButtonElement>(".wc-period-row button")].find((b) => b.textContent === "저장")!;

it("저장은 창을 열 때 읽은 기획을 기준으로 보낸다 — 그사이 바뀐 서버 값은 409 병합 창이 맡는다", async () => {
  const opened: Planning = { revision: 1, start_date: "2026-10-01", due_date: "2026-10-31", archive_after_days: 60, note: "메모" };
  getPlanning.mockResolvedValueOnce(opened)
    .mockResolvedValue({ ...opened, revision: 2, due_date: "2026-12-31" }); // 다른 관리자가 종료일을 바꿨다
  const savePlanning = vi.fn(async (_pid: string, _baseline: Planning, body: Planning) => body);
  await act(async () => { root.render(<ConsolePeriodDialog sub={SUB} savePlanning={savePlanning} onClose={() => {}} onSaved={() => {}} />); });
  await settle();

  await typeDate(host.querySelector<HTMLInputElement>("#wc-start-p1")!, "2026-10-05"); // 시작일만 고친다
  await act(async () => { saveButton().click(); });
  await settle();

  expect(savePlanning).toHaveBeenCalledTimes(1);
  const [, baseline, body] = savePlanning.mock.calls[0];
  expect(baseline.revision).toBe(1); // 최신(2)이 아니라 연 때의 기준 — 서버가 409 로 병합 창을 띄운다
  expect(body).toMatchObject({ revision: 1, start_date: "2026-10-05", due_date: "2026-10-31", archive_after_days: 60, note: "메모" });
});

it("기획을 받기 전에는 시작일·종료일도 못 고친다 — 늦게 온 응답이 입력을 덮지 않게(Codex 2라운드 A-3)", async () => {
  let answer: (value: Planning) => void = () => {};
  getPlanning.mockReturnValue(new Promise<Planning>((resolve) => { answer = resolve; }));
  await act(async () => { root.render(<ConsolePeriodDialog sub={SUB} savePlanning={vi.fn()} onClose={() => {}} onSaved={() => {}} />); });
  await settle();
  expect(host.querySelector<HTMLInputElement>("#wc-start-p1")!.disabled).toBe(true);
  expect(host.querySelector<HTMLInputElement>("#wc-due-p1")!.disabled).toBe(true);

  await act(async () => answer({ revision: 1, start_date: "2026-10-01", due_date: "2026-10-31", archive_after_days: 60 }));
  await settle();
  expect(host.querySelector<HTMLInputElement>("#wc-start-p1")!.disabled).toBe(false);
  expect(host.querySelector<HTMLInputElement>("#wc-due-p1")!.disabled).toBe(false);
});

it("열 때 기획을 못 읽은 줄은 저장할 수 없다 — 자동 보관 일수를 30 으로 덮지 않게", async () => {
  getPlanning.mockRejectedValue(new Error("네트워크"));
  const savePlanning = vi.fn();
  await act(async () => { root.render(<ConsolePeriodDialog sub={SUB} savePlanning={savePlanning} onClose={() => {}} onSaved={() => {}} />); });
  await settle();

  await typeDate(host.querySelector<HTMLInputElement>("#wc-due-p1")!, "2026-11-30");
  expect(saveButton().disabled).toBe(true);
  expect(host.textContent).toContain("기획을 읽지 못했습니다");
  expect(savePlanning).not.toHaveBeenCalled();
});
