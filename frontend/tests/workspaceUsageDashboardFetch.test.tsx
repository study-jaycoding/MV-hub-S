// @vitest-environment jsdom
// 사용량 패널의 조회(2026-10-03 점검) —
// L3-3: 기간 '전체 적용'이 꺼져 있으면 차트 모델·기간을 바꿔도 상단 사용량(team-overview)을 다시 읽지 않는다(필터 내용이 같다).
// L3-4: 판(워크스페이스·관리 표·상세)에 가려진 동안 overview·드릴·timeseries 를 읽지 않는다. 머리글의 workspaces 는 계속 읽고,
//       판을 닫으면 그때 읽는다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkspaceUsageDashboard } from "../src/components/manage/WorkspaceUsageDashboard";

const mocks = vi.hoisted(() => ({ workspaces: vi.fn(), teamOverview: vi.fn(), teamTimeseries: vi.fn(), creditPlan: vi.fn() }));
vi.mock("../src/lib/manageApi", () => ({ manageApi: mocks }));
vi.mock("../src/lib/modelCatalog", async (original) => ({
  ...(await original<typeof import("../src/lib/modelCatalog")>()),
  useModelDisplayName: () => (code?: string | null) => code ?? "",
}));

const OVERVIEW = {
  totals: { count: 1, credits: 10, workers: 1, projects: 1, models: 1 },
  by_worker: [], by_project: [], by_output_type: [], output_models: [], worker_models: [], project_models: [], folder_efficiency: [], matrix: [],
  by_model: [{ model: "m1", count: 1, credits: 10, final_count: 0 }],
};

let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.workspaces.mockResolvedValue({ workspaces: [{ id: "a", name: "A", member_count: 1 }] });
  mocks.teamOverview.mockResolvedValue(OVERVIEW);
  mocks.teamTimeseries.mockResolvedValue({ buckets: [] });
  mocks.creditPlan.mockReturnValue(new Promise(() => {})); // 크레딧 카드 — 이 시험의 관심 밖
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); }); };
const render = async (props: { reloadSignal?: number; consoleOpen?: boolean }) => {
  await act(async () => {
    root.render(<WorkspaceUsageDashboard workspaceId="a" reloadSignal={props.reloadSignal ?? 0} consoleOpen={props.consoleOpen}
      onToggleConsole={() => {}} tableSlot={<div data-slot />} />);
  });
  await settle();
};

it("L3-3 '전체 적용'이 꺼져 있으면 차트 모델을 바꿔도 상단 사용량은 다시 읽지 않는다", async () => {
  await render({});
  expect(mocks.teamOverview).toHaveBeenCalledTimes(1);
  const select = host.querySelector<HTMLSelectElement>('select[aria-label="그래프 모델 필터"]')!;
  await act(async () => { select.value = "m1"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  await settle();
  expect(mocks.teamTimeseries).toHaveBeenCalledTimes(2); // 차트는 새 모델로 다시 읽는다
  expect(mocks.teamOverview).toHaveBeenCalledTimes(1);
});

it("L3-4 판에 가려진 동안은 사용량을 읽지 않고(머리글 workspaces 는 읽음), 판을 닫으면 읽는다", async () => {
  await render({ consoleOpen: true });
  await render({ consoleOpen: true, reloadSignal: 1 });
  expect(host.querySelector("[data-slot]")).not.toBeNull();
  expect(mocks.workspaces).toHaveBeenCalledTimes(2);
  expect(mocks.teamOverview).not.toHaveBeenCalled();
  expect(mocks.teamTimeseries).not.toHaveBeenCalled();
  await render({ consoleOpen: false, reloadSignal: 1 });
  expect(mocks.teamOverview).toHaveBeenCalledTimes(1);
  expect(mocks.teamTimeseries).toHaveBeenCalledTimes(1);
});
