// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MyUsageWindow } from "../src/components/MyUsageWindow";
import { jsonFetch } from "../src/lib/http";
import { setLang } from "../src/lib/i18n";
import type { MyUsage } from "../src/lib/myUsage";

vi.mock("../src/lib/http", () => ({ jsonFetch: vi.fn(), isHttpStatus: (e: { status?: number }, status: number) => e?.status === status }));
let root: Root;
let host: HTMLDivElement;
let opener: HTMLButtonElement;
const close = vi.fn();
function value(patch: Partial<MyUsage> = {}): MyUsage {
  return { workspace_id: "ws", range: "period", space: "this", basis: "api", used: 7, used_real: 5, used_estimated: 2,
    refunded: 3, generation_count: 2, estimated_count: 1, unknown_count: 3, overdue_pending_count: 1, pending_count: 4,
    failed_count: 2, failed_refunded_count: 1, sources: [{ source: "web", net: 6 }, { source: "other", net: -1 }],
    rows: [{ row_id: "refund", created_at: 100, source: "web", type: "generation", model: "Model", workspace_id: "ws", workspace_name: "WS", status: "failed", state: "future_state", error_code: "error", charged: 4, refunded: 3, net: 1, pending: false },
      { row_id: "pending", created_at: 200, source: "mv", type: "generation", model: "Pending Model", workspace_id: "ws", workspace_name: "WS", status: "pending", state: null, error_code: null, charged: null, refunded: null, net: 2, pending: true }],
    total_count: 1005, returned_count: 1000, truncated: true, ...patch };
}
async function render(workspace = "ws", account = "a") {
  await act(async () => root.render(<MyUsageWindow workspaceId={workspace} accountKey={account} onClose={close} />));
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setLang("ko");
  close.mockReset();
  vi.mocked(jsonFetch).mockReset();
  host = document.createElement("div");
  opener = document.createElement("button");
  document.body.append(host, opener);
  opener.focus();
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove(); opener.remove();
  vi.restoreAllMocks();
});

it("renders the selected tiles, all source amounts, refunds and pending estimates", async () => {
  vi.mocked(jsonFetch).mockResolvedValue(value());
  await render();
  expect(document.querySelectorAll(".my-usage-tiles>div")).toHaveLength(4);
  expect(document.querySelector(".my-usage-bars")?.textContent).toContain("-1");
  expect(document.querySelector("del")?.textContent).toContain("4");
  expect(document.querySelector("tbody")?.textContent).toContain("≈ 2");
  expect(document.body.textContent).toContain("최근 1,000건 표시 · 합계는 전체");
  expect(document.body.textContent).toContain("오류 보고 후 전액 환불 1건");
  expect(document.body.textContent).toContain("미확인 2건");
  expect(document.body.textContent).toContain("오래된 미매칭 1건 (60분 초과)");
  expect(document.querySelectorAll(".my-usage-tiles>div")[3].textContent).toBe("1집계 전");
  expect(document.body.textContent).toContain("집계 전 1건");
  expect(vi.mocked(jsonFetch).mock.calls[0][0]).toContain("range=period&space=this");
});

it.each(["facts", "unavailable"] as const)("shows %s reasons without API zero tiles", async basis => {
  vi.mocked(jsonFetch).mockResolvedValue(value({ basis, basis_reason: "identity_unlinked", rows: [], sources: [], used: basis === "facts" ? 9 : null,
    generation_count: null, estimated_count: null, unknown_count: null, pending_count: null, overdue_pending_count: null }));
  await render();
  expect(document.querySelector(".my-usage-tiles")).toBeNull();
  expect(document.querySelector("table")).toBeNull();
  expect(document.body.textContent).toContain(basis === "facts" ? "계정 신원 미연결" : "확인 불가");
});

it("shows zero pending estimates when only old unmatched records remain", async () => {
  vi.mocked(jsonFetch).mockResolvedValue(value({ estimated_count: 0, used_estimated: 0, pending_count: 1, unknown_count: 1, overdue_pending_count: 1 }));
  await render();
  expect(document.querySelectorAll(".my-usage-tiles>div")[3].textContent).toBe("0집계 전");
  expect(document.body.textContent).toContain("오래된 미매칭 1건 (60분 초과)");
  expect(document.body.textContent).not.toContain("미확인 1건");
  expect([...document.querySelectorAll("p")].some(p => p.textContent?.includes("≈"))).toBe(false);
});

it.each([404, 403, 502])("keeps HTTP %s separate from zero usage", async status => {
  vi.mocked(jsonFetch).mockRejectedValue({ status });
  await render();
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(status === 404 ? "서버 업데이트가 필요합니다" : "사용량을 확인할 수 없습니다");
  expect(document.querySelector(".my-usage-tiles")).toBeNull();
});

it("rejects a legacy response without basis", async () => {
  vi.mocked(jsonFetch).mockResolvedValue({ workspace_id: "ws", used: 0 });
  await render();
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("서버 업데이트가 필요합니다");
});

it("discards late responses on account, workspace, range and space changes", async () => {
  const pending: ((v: unknown) => void)[] = [];
  vi.mocked(jsonFetch).mockImplementation(() => new Promise(resolve => pending.push(resolve)));
  await render();
  await render("other", "b");
  await act(async () => { [...document.querySelectorAll("nav button")].find(b => b.textContent === "오늘")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await act(async () => { const select = document.querySelector("select")!; select.value = "all"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  await act(async () => { pending[3](value({ workspace_id: "other", range: "today", space: "all", used_real: 42 })); });
  expect(document.querySelector(".my-usage-tiles")?.textContent).toContain("42");
  await act(async () => { pending[0](value({ used_real: 999 })); pending[1](value({ used_real: 888 })); pending[2](value({ used_real: 777 })); });
  expect(document.querySelector(".my-usage-tiles")?.textContent).toContain("42");
  expect(document.body.textContent).not.toContain("999");
});

it("focuses the dialog, handles Escape once and restores focus on close", async () => {
  vi.mocked(jsonFetch).mockResolvedValue(value());
  await render();
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.contains(document.activeElement)).toBe(true);
  await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(close).toHaveBeenCalledTimes(1);
  await act(async () => root.render(null));
  expect(document.activeElement).toBe(opener);
});

it("uses the existing English dictionary for the new usage screen", async () => {
  setLang("en");
  vi.mocked(jsonFetch).mockResolvedValue(value());
  await render();
  expect(document.querySelector("h2")?.textContent).toBe("My usage");
  expect(document.body.textContent).toContain("Actual usage, net of refunds");
  expect(document.body.textContent).toContain("Higgsfield usage");
  expect(document.body.textContent).toContain("Latest 1,000 rows shown; totals include all rows");
  expect(document.body.textContent).toContain("1 old unmatched records (over 60 minutes)");
  expect(document.body.textContent).toContain("2 unconfirmed");
  setLang("ko");
});
