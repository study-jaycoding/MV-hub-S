// @vitest-environment jsdom
// 사용량 패널의 조회(2026-10-03 점검) —
// L3-3: 기간 '전체 적용'이 꺼져 있으면 차트 모델·기간을 바꿔도 상단 사용량(team-overview)을 다시 읽지 않는다(필터 내용이 같다).
// L3-4: 판(워크스페이스·관리 표·상세)에 가려진 동안 overview·드릴·timeseries 를 읽지 않는다. 머리글의 workspaces 는 계속 읽고,
//       판을 닫으면 그때 읽는다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkspaceUsageDashboard } from "../src/components/manage/WorkspaceUsageDashboard";
import { CreditPoolSection } from "../src/components/manage/CreditPoolSection";
import { setLang } from "../src/lib/i18n";

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
  setLang("ko");
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

it("출처는 크레딧 카드별로 표시하고 기존 생성 분석은 MV 기록으로 유지한다", async () => {
  mocks.creditPlan.mockResolvedValue({ month: "2026-11", configured: true, my_group: {
    id: "g", name: "Group", member_count: 2, monthly_limit: 100, quota_total: 200, used_period: 3, used_month: 3,
    my_used_period: 1, my_quota: 100, my_remaining: 99, my_quota_source: "auto",
    period_usage: { basis: "mixed", fallback_count: 1 }, my_period_usage: { basis: "api" },
  } });
  await act(async () => root.render(<WorkspaceUsageDashboard workspaceId="a" scope="mine" />));
  await settle();
  expect(host.querySelector(".credit-card")?.textContent).toContain("힉스필드 기준");
  expect(host.querySelector(".credit-card")?.textContent).toContain("일부 MV 기록 기준");
  expect(host.querySelector(".work-source-label")?.textContent).toContain("생성 기록 분석 · 프로젝트·모델 차트는 MV 기록 기준");
});

it.each(["api", "facts", "mixed", undefined] as const)("풀 머리글과 미확인 안내가 %s 출처를 따른다", async basis => {
  mocks.creditPlan.mockResolvedValue({ month: "2026-11", configured: true, groups: [], topups: [], history: [], pool: {
    monthly_topup: 100, used_month: 1.25, unknown_month: 1, balance: 10, balance_seen_at: null,
    month_start_balance: null, month_start_day: null, month_usage: basis ? { basis, fallback_count: 1 } : undefined,
  } });
  await act(async () => root.render(<CreditPoolSection workspaceId="a" scope="all" />));
  await settle();
  const header = host.querySelector(".credit-card .usage-card-head")!.textContent!;
  const text = host.querySelector(".credit-pool-grid")!.textContent!;
  if (basis) {
    expect(header).toContain(basis === "api" ? "힉스필드 기준" : basis === "facts" ? "MV 생성 기록 기준" : "일부 MV 기록 기준");
    expect(header).not.toContain("사용은 팀 기록 장부");
    expect(text).not.toContain("사용 (팀 기록 장부)");
  } else {
    expect(header).toContain("사용은 팀 기록 장부");
    expect(text).toContain("11월 사용 (팀 기록 장부)");
  }
  expect(text).toContain(basis === "api" ? "API 미매칭 MV 기록 1건 · 사용 합계에 미포함" : "미상 1건 제외");
});

it.each([true, false])("멤버 카드의 출처 안내는 신서버=%s 계약을 따른다", async modern => {
  mocks.creditPlan.mockResolvedValue({ month: "2026-11", configured: true, my_group: {
    id: "g", name: "Group", member_count: 1, quota_total: 100, monthly_limit: 100, used_month: 3,
    my_quota: 100, my_remaining: 97, my_quota_source: "auto", estimated: false,
    my_period_usage: modern ? { basis: "api" } : undefined,
  } });
  await act(async () => root.render(<CreditPoolSection workspaceId="a" scope="mine" />));
  await settle();
  expect(host.textContent).toContain(modern ? "사용량 출처는 위 기간별 표시를 따릅니다" : "팀 기록 장부 기준");
  if (!modern) expect(host.textContent).not.toContain("사용량 출처는 위 기간별 표시를 따릅니다");
});

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
