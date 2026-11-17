// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { api } from "../src/api";
import { getConnectionKey, setConnectionKey } from "../src/lib/accountScope";

import {
  formatTelemetryLastSuccess,
  latestSyncSuccess,
  syncFailedCount,
  syncPendingCount,
  type SyncStatus,
  useSyncStatus,
  balanceDeliveryNotices,
} from "../src/lib/useSyncStatus";

const status = (overrides: Partial<SyncStatus> = {}): SyncStatus => ({
  pending: 0,
  failed: 0,
  last_error: null,
  oldest_dirty: null,
  last_success_at: null,
  account_report_pending: 0,
  account_report_failed: 0,
  account_report_last_error: null,
  account_report_oldest_dirty: null,
  account_report_last_success_at: null,
  ...overrides,
});

describe("telemetry sync status", () => {
  it("생성정보와 계정 보고 중 더 최근 성공 시각을 선택한다", () => {
    expect(
      latestSyncSuccess(
        status({
          last_success_at: "2026-08-16T01:00:00Z",
          account_report_last_success_at: "2026-08-16T02:00:00Z",
        }),
      ),
    ).toBe("2026-08-16T02:00:00Z");
  });

  it("한 채널의 시각이 깨졌으면 정상인 다른 채널을 선택한다", () => {
    expect(
      latestSyncSuccess(
        status({
          last_success_at: "not-a-date",
          account_report_last_success_at: "2026-08-16T02:00:00Z",
        }),
      ),
    ).toBe("2026-08-16T02:00:00Z");
  });

  it("모든 성공 시각이 깨졌으면 오류 표시를 위해 원문을 보존한다", () => {
    expect(latestSyncSuccess(status({ last_success_at: "not-a-date" }))).toBe("not-a-date");
  });

  it("성공 기록이 없으면 그 상태를 명확히 표시한다", () => {
    expect(formatTelemetryLastSuccess(null)).toBe("마지막 성공 기록 없음");
  });

  it("깨진 시각은 잘못된 날짜로 표시하지 않는다", () => {
    expect(formatTelemetryLastSuccess("not-a-date")).toBe("마지막 성공 시각 확인 불가");
  });

  it("UTC 성공 시각을 한국 시간 안내로 변환한다", () => {
    const text = formatTelemetryLastSuccess("2026-08-16T01:23:45.000Z");
    expect(text).toContain("마지막 성공");
    expect(text).toContain("2026");
    expect(text).toContain("10:23");
  });

  it("생성정보와 계정·거래 보고의 대기·실패를 합산한다", () => {
    const value = status({
      pending: 2,
      failed: 1,
      account_report_pending: 3,
      account_report_failed: 2,
      account_report_dead: 4,
    });
    expect(syncPendingCount(value)).toBe(5);
    expect(syncFailedCount(value)).toBe(7);
  });
  it("잔액 전달 대기는 세되 매니징 실패 수에는 섞지 않는다", () => {
    expect(syncPendingCount(status({pending:2,account_report_pending:3,balance_pending:4}))).toBe(9);
    expect(syncFailedCount(status({failed:1,balance_failed:2,balance_conflict:1}))).toBe(1);
  });
  it("잔액 재시도·옛 서버·내용 불일치를 나누고 오류 코드를 화면에 노출하지 않는다", () => {
    const notices=balanceDeliveryNotices(status({balance_pending:8,balance_failed:8,balance_unsupported:2,balance_conflict:3,balance_last_error_code:"account_mismatch"}));
    expect(notices.map((n)=>n.text)).toEqual(["잔액 확인 3건 서버 전달 대기","잔액 확인 2건 서버 업데이트 뒤 전달","잔액 확인 3건 전달 내용을 확인해 주세요"]);
    expect(notices[0].title).toBe("힉스필드 계정과 허브 로그인 계정이 같은지 확인해 주세요.");
    expect(JSON.stringify(notices)).not.toContain("account_mismatch");
    expect(balanceDeliveryNotices(status({balance_pending:2,balance_failed:2,balance_unsupported:2}))).toHaveLength(1);
    expect(balanceDeliveryNotices(status({balance_pending:1,balance_failed:1,balance_last_error_code:"unexpected_internal_code"}))[0].title).not.toContain("unexpected_internal_code");
  });
});

it("서버 문맥이 바뀌면 이전 잔액 전달 상태 응답을 버린다", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);
  vi.spyOn(document,"visibilityState","get").mockReturnValue("visible");
  const originalKey=getConnectionKey();
  let first!: (s:SyncStatus)=>void, second!: (s:SyncStatus)=>void;
  vi.spyOn(api,"syncStatus").mockReturnValueOnce(new Promise((resolve)=>{ first=resolve; }))
    .mockReturnValueOnce(new Promise((resolve)=>{ second=resolve; }));
  const host=document.createElement("div");
  document.body.appendChild(host);
  const root=createRoot(host);
  function View() { const value=useSyncStatus(); return createElement("span",null,value?.balance_pending??"—"); }
  try {
    setConnectionKey("balance-server-a");
    await act(async()=>root.render(createElement(View)));
    setConnectionKey("balance-server-b");
    await act(async()=>root.render(createElement(View)));
    expect(host.textContent).toBe("—");
    await act(async()=>second(status({balance_pending:4})));
    await act(async()=>first(status({balance_pending:99})));
    expect(host.textContent).toBe("4");
  } finally {
    act(()=>root.unmount()); host.remove(); setConnectionKey(originalKey);
    vi.restoreAllMocks(); vi.unstubAllGlobals();
  }
});
