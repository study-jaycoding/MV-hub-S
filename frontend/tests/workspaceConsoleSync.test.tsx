// @vitest-environment jsdom
// 대시보드 워크스페이스 판의 서브스페이스 ↔ 머리 선택 맞물림(Jay 2026-09-30) — 서브스페이스에서 고르면 머리가 따라가고, 머리 선택이 메인·서브면 서브스페이스도 따라간다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkspaceConsole } from "../src/components/manage/console/WorkspaceConsole";
import type { ManageCaps } from "../src/lib/useManageCaps";
import type { ConsoleOverview } from "../src/lib/workspaceConsole";

const overview = vi.hoisted(() => vi.fn());
const plan = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/manageApi", () => ({ manageApi: { consoleOverview: overview, creditPlan: plan } }));
// 화면 본체는 이 시험의 관심 밖 — 어느 워크스페이스를 보이는지만 남긴다
vi.mock("../src/components/manage/console/ConsoleSubView", () => ({ ConsoleSubView: ({ sub }: { sub: { id: string } }) => <div data-shown={sub.id} />, CreditDialog: () => null }));
vi.mock("../src/components/manage/console/ConsoleMainParts", () => ({ PoolCard: () => <div data-shown="main" />, SubTable: () => null }));
vi.mock("../src/components/manage/console/CreditCalendar", () => ({ CreditCalendar: () => null }));

const sub = (id: string) => ({ id, name: id.toUpperCase(), status: "active", participants: { reported: 1, unconfirmed: 0 }, projects: [] });
const caps = { loaded: true, authOff: false, system: false, viewerUid: null, createProject: false, grantRole: false, readAll: true } as ManageCaps;
let root: Root, host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  overview.mockResolvedValue({ today: "2026-09-30", main: { id: "mv", name: "MV", balance: 0, balance_seen_at: null, reported: 1 }, subs: [sub("a"), sub("b")], pending: [],
    totals: {}, schedule: [], allocation: {}, calendar: { from: "", to: "", events: [] } });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const render = async (selectedId: string | undefined, onSelectedChange = vi.fn(), workingId?: string) => {
  await act(async () => { root.render(<WorkspaceConsole caps={caps} reloadSignal={0} selectedId={selectedId} onSelectedChange={onSelectedChange} workingId={workingId} />); });
  await act(async () => {});
  return onSelectedChange;
};
const shown = () => host.querySelector("[data-shown]")?.getAttribute("data-shown");
const railButton = (name: string) => [...host.querySelectorAll<HTMLButtonElement>(".wc-rail .wc-ws")].find((button) => button.textContent?.replace("★", "").startsWith(name))!;

it("풀 카드는 확인 시각을 KST로 표시하고 불완전한 합계의 그래프를 그리지 않는다", async () => {
  const { PoolCard } = await vi.importActual<typeof import("../src/components/manage/console/ConsoleMainParts")>("../src/components/manage/console/ConsoleMainParts");
  const at = Date.parse("2026-11-17T00:30:00Z");
  vi.spyOn(Date, "now").mockReturnValue(at + 600_000);
  const data = {
    today: "2026-11-17", main: { id: "main", name: "Main", balance: 50, balance_seen_at: null, reported: 1, balance_meta: { basis: "observed", observed_at_ms: at } },
    subs: [], pending: [], schedule: [], calendar: { from: "", to: "", events: [] },
    totals: { unknown_workspace_count: 1, legacy_workspace_count: 1, stale_workspace_count: 1 },
    allocation: { source: "estimate", base: null, base_day: null, allocated: null, spent: null, unused: 20, complete: false },
  } as ConsoleOverview;
  await act(async () => { root.render(<PoolCard data={data} canEdit={false} onChanged={() => {}} />); });
  expect(host.textContent).toContain("잔액은 11/17 09:30 확인 (10분 전)");
  expect(host.textContent).toContain("확인 안 된 서브 3곳");
  expect(host.textContent).toContain("계산할 수 없음");
  expect(host.querySelector(".wc-pool-bar")).toBeNull();
  expect(host.textContent).not.toMatch(/관측|precision|legacy|API/);

  const complete = { ...data, allocation: { ...data.allocation, complete: true, allocated: 70, spent: 50 } };
  await act(async () => { root.render(<PoolCard data={complete} canEdit={false} onChanged={() => {}} />); });
  expect(host.querySelector(".wc-pool-bar")).not.toBeNull();
});

it("서브 잔액은 공간·권한 문맥이 바뀐 뒤 도착한 이전 응답을 버린다", async () => {
  const { ConsoleSubView } = await vi.importActual<typeof import("../src/components/manage/console/ConsoleSubView")>("../src/components/manage/console/ConsoleSubView");
  let resolveOld!: (value: unknown) => void;
  plan.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
  const props = { workspaceId: "old", name: "Old", tier: "sub" as const, today: "2026-11-17", canEdit: false,
    conflict: {} as never, onChanged: () => {}, contextKey: "account-a" };
  await act(async () => { root.render(<ConsoleSubView {...props} />); });
  plan.mockResolvedValue({ pool: { balance: 42, balance_seen_at: null, topups_month: { credits: 0, count: 0 } }, groups: [] });
  await act(async () => { root.render(<ConsoleSubView {...props} workspaceId="new" contextKey="account-b" />); });
  await act(async () => { resolveOld({ pool: { balance: 987654, balance_seen_at: null, topups_month: { credits: 0, count: 0 } }, groups: [] }); });
  expect(host.querySelector(".credit-pool-grid strong")?.textContent).toBe("42");
  expect(host.textContent).not.toContain("987,654");
});

it("머리에서 고른 서브를 서브스페이스도 보이고, 서브스페이스 목록에서 고르면 머리에 알린다", async () => {
  const onChange = await render("a", vi.fn(), "b");
  expect(shown()).toBe("a"); // 머리 = 서브 A → 서브스페이스도 A(작업하던 B 보다 머리 선택이 먼저)
  expect(onChange).not.toHaveBeenCalled(); // 따라가기만 할 뿐 되알리지 않는다
  await act(async () => { railButton("B").click(); });
  expect(shown()).toBe("b");
  expect(onChange).toHaveBeenCalledWith("b"); // 서브스페이스에서 고르면 머리가 따라간다
  await act(async () => { railButton("MV").click(); });
  expect(onChange).toHaveBeenLastCalledWith("mv");
});

it("머리가 '전체'·연결 안 된 곳이면 내가 작업하던 워크스페이스(메인·서브일 때), 없으면 메인을 열고 머리에 알린다", async () => {
  let onChange = await render(undefined, vi.fn(), "b");
  expect(shown()).toBe("b");
  expect(onChange).toHaveBeenCalledWith("b");
  onChange = await render("not-linked", vi.fn(), "also-not-linked");
  expect(shown()).toBe("main");
  expect(onChange).toHaveBeenCalledWith("mv");
});

it("머리와 맞물리지 않으면(onSelectedChange 없음) 제 선택(처음엔 메인)을 둔다", async () => {
  await act(async () => { root.render(<WorkspaceConsole caps={caps} reloadSignal={0} />); });
  await act(async () => {});
  expect(shown()).toBe("main");
});

it("메인은 바뀌지 않는다 — 메인이 목록에서 사라졌으면(main_orphan) 관리자에게도 지정 선택기 대신 복구 안내", async () => {
  const admin = { ...caps, system: true, createProject: true };
  overview.mockResolvedValue({ today: "2026-09-30", main: null, main_orphan: { id: "mv" }, subs: [sub("a")], pending: [],
    totals: {}, schedule: [], allocation: {}, calendar: { from: "", to: "", events: [] } });
  await act(async () => { root.render(<WorkspaceConsole caps={admin} reloadSignal={0} />); });
  await act(async () => {});
  expect(host.querySelector('.wc-rail [role="alert"]')?.textContent).toContain("메인 워크스페이스를 찾을 수 없습니다");
  expect(host.querySelector("#wc-set-main")).toBeNull();
  // 메인이 아직 없을 때(main_orphan 없음)는 관리자에게 지정 선택기
  overview.mockResolvedValue({ today: "2026-09-30", main: null, subs: [sub("a")], pending: [],
    totals: {}, schedule: [], allocation: {}, calendar: { from: "", to: "", events: [] } });
  await act(async () => { root.render(<WorkspaceConsole caps={admin} reloadSignal={1} />); });
  await act(async () => {});
  expect(host.querySelector("#wc-set-main")).not.toBeNull();
});
