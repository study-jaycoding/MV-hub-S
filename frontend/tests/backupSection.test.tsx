// @vitest-environment jsdom
// 설정 '자료 관리' ② 백업 칸(저장 통합 1-A, docs/status/저장통합_1A_자료관리칸_2026-11-12.md).
//  줄이는 값은 dry_run 미리보기 → 확인 → 그 확인 토큰으로만 저장한다(서버 규칙을 화면이 그대로 따른다).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  backupPolicy: vi.fn(),
  saveBackupPolicy: vi.fn(),
  backupNow: vi.fn(),
}));
vi.mock("../src/api", () => ({ api, GEN_PAGE: 200 }));

import { HttpError } from "../src/lib/http";
import { BackupSection, backupSummary, backupWarnings } from "../src/components/settings/BackupSection";
import type { BackupContinuityStatus, BackupRetentionStatus } from "../src/lib/assetsApi";

const POLICY = { quiet_minutes: 5, min_interval_minutes: 15, recent: 8, daily_days: 14, weekly_weeks: 8 };
const CHOICES = {
  quiet_minutes: [1, 5, 10],
  min_interval_minutes: [5, 15, 30, 60],
  recent: [4, 8, 16],
  daily_days: [7, 14, 30],
  weekly_weeks: [4, 8, 12],
};
const MB = 1024 * 1024;

function retention(extra: Partial<BackupRetentionStatus> = {}): BackupRetentionStatus {
  return {
    policy: { ...POLICY, version: 1, source: "saved" },
    set_count: 23,
    oldest_created_at: "2026-10-02T03:00:00+00:00",
    newest_created_at: "2026-11-12T03:00:00+00:00",
    total_bytes: 350 * MB,
    latest_set_bytes: 15 * MB,
    estimated_max_bytes: 450 * MB,
    reasons: { auto: 22, manual: 1, legacy: 0 },
    unregistered: 0,
    incomplete: 0,
    sidecar_invalid: 0,
    sequence_conflict: 0,
    blocked: null,
    inverted: 0,
    leftovers: 0,
    leftover_bytes: 0,
    delete_failed: 0,
    last_error: null,
    ...extra,
  };
}

function status(extra: Partial<BackupRetentionStatus> = {}): BackupContinuityStatus {
  return {
    local: { set_count: 23, latest_created_at: null, latest_file_count: 3, retention: retention(extra) },
    shared: {
      automatic: true, state: "success", pending: 0, failed: 0,
      last_attempt_at: null, last_success_at: null, last_error_code: null,
    },
  };
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.backupPolicy.mockReset().mockResolvedValue({ policy: POLICY, version: 1, source: "saved", choices: CHOICES });
  api.saveBackupPolicy.mockReset();
  api.backupNow.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const flush = () => act(async () => { for (let i = 0; i < 4; i += 1) await Promise.resolve(); });
const select = (key: string) => host.querySelector<HTMLSelectElement>(`select[aria-label="${key}"]`)!;
async function choose(key: string, value: number) {
  await act(async () => {
    const element = select(key);
    element.value = String(value);
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
}
async function mount(current = status(), onRefresh = vi.fn()) {
  await act(async () => root.render(<BackupSection status={current} onRefresh={onRefresh} />));
  await flush();
  return onRefresh;
}

describe("백업 칸", () => {
  it.each([
    ["agent_chat_busy", "대화 기록을 복원 중"],
    ["agent_chat_unreadable", "대화 기록을 읽지 못해"],
    ["asset_mounts_invalid", "폴더 등록 자료를 읽지 못해"],
    ["backup_scope_changed", "백업 중 계정 자료가 바뀌어"],
    ["share_database_changed", "백업 중 계정 자료가 바뀌어"],
  ])("integration: %s 경고를 기존 줄에 표시", (code, message) => {
    expect(backupWarnings(retention({ last_error: { code, at: "2026-11-13T00:00:00Z" } })).join(" ")).toContain(message);
  });
  it("상태 줄 — 세트 수·가장 오래된 날·용량·서버 복제, 고른 값의 예상 최대 용량", async () => {
    await mount();
    const text = host.querySelector(".settings-backup-status")!.textContent!;
    expect(text).toContain("백업 23세트");
    expect(text).toContain("가장 오래된 것 10-02");
    expect(text).toContain("350.0 MB");
    expect(text).toContain("서버 복제 정상");
    expect(host.textContent).toContain("이대로면 최대 약 450.0 MB"); // 15MB × (8+14+8)
    expect([...select("recent").options].map((o) => o.textContent)).toEqual(["4장", "8장", "16장"]);
    expect(select("recent").value).toBe("8");
  });

  it("막힌 이유·못 지운 수·디스크 부족은 쉬운 말 경고로, 묶음 제목 밑 줄에도", async () => {
    const bad = status({ blocked: "clock_skew", delete_failed: 2, last_error: { code: "disk_full", at: "x" } });
    expect(backupWarnings(bad.local.retention)).toEqual([
      "컴퓨터 시계가 맞지 않아 오래된 백업 정리를 멈췄습니다",
      "오래된 백업 2세트를 지우지 못했습니다(다음에 다시)",
      "디스크가 부족해 백업하지 못했습니다",
    ]);
    expect(backupSummary(bad)).toBe(
      "백업 23세트(10-02부터) · ⚠ 컴퓨터 시계가 맞지 않아 오래된 백업 정리를 멈췄습니다 · ⚠ 오래된 백업 2세트를 지우지 못했습니다(다음에 다시) · ⚠ 디스크가 부족해 백업하지 못했습니다",
    );
    expect(backupSummary(status())).toBe("백업 23세트(10-02부터)");
    await mount(status({ blocked: "policy_invalid" }));
    expect(host.querySelectorAll(".settings-backup-warn")).toHaveLength(1);
    expect(host.textContent).toContain("보관 설정을 읽지 못해 정리를 멈췄습니다");
  });

  it("늘리는 값 — 미리보기에 지울 것이 없으면 묻지 않고 저장", async () => {
    const confirm = vi.spyOn(window, "confirm");
    api.saveBackupPolicy
      .mockResolvedValueOnce({ saved: false, version: 1, preview: { delete_count: 0, confirm_token: null } })
      .mockResolvedValueOnce({ saved: true, version: 2, preview: { delete_count: 0, confirm_token: null } });
    const onRefresh = await mount();
    await choose("recent", 16);
    expect(confirm).not.toHaveBeenCalled();
    expect(api.saveBackupPolicy.mock.calls).toEqual([
      [{ ...POLICY, recent: 16, version: 1, dry_run: true }],
      [{ ...POLICY, recent: 16, version: 1, confirm_token: null }],
    ]);
    expect(onRefresh).toHaveBeenCalled();
    expect(host.textContent).toContain("저장했습니다");
  });

  it("줄이는 값 — 지울 수·기간·용량을 묻고, 확인하면 그 토큰으로 저장 · 취소면 저장 안 함", async () => {
    const preview = {
      delete_count: 6, delete_bytes: 90 * MB, delete_oldest_at: "2026-10-02T03:00:00+00:00",
      delete_newest_at: "2026-10-20T03:00:00+00:00", oldest_kept_at: "2026-10-21T03:00:00+00:00",
      blocked: null, confirm_token: "tok123",
    };
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    api.saveBackupPolicy.mockResolvedValue({ saved: false, version: 1, preview });
    await mount();
    await choose("recent", 4);
    expect(confirm.mock.calls[0][0]).toContain("오래된 백업 6세트 (10-02 ~ 10-20), 90.0 MB가 지워집니다");
    expect(api.saveBackupPolicy).toHaveBeenCalledTimes(1); // 미리보기만
    expect(host.textContent).toContain("바꾸지 않았습니다");

    api.saveBackupPolicy.mockReset()
      .mockResolvedValueOnce({ saved: false, version: 1, preview })
      .mockResolvedValueOnce({ saved: true, version: 2, preview });
    await choose("recent", 4);
    expect(api.saveBackupPolicy.mock.calls[1][0]).toEqual({ ...POLICY, recent: 4, version: 1, confirm_token: "tok123" });
  });

  it("시계 문제가 남아 있으면 줄이는 값은 묻지도 저장하지도 않고 까닭을 보인다 · 경고 줄에 정리 안 하는 수", async () => {
    const confirm = vi.spyOn(window, "confirm");
    api.saveBackupPolicy.mockResolvedValueOnce({
      saved: false, version: 1, preview: { delete_count: 3, blocked: "clock_skew", confirm_token: "t" },
    });
    await mount(status({ inverted: 5, leftovers: 1 }));
    expect(host.textContent).toContain("오래된 백업 5세트를 정리하지 않고 있습니다");
    expect(host.textContent).toContain("반쪽 백업 1개는 지우지 않고 남겨 둡니다");
    await choose("recent", 4);
    expect(confirm).not.toHaveBeenCalled();
    expect(api.saveBackupPolicy).toHaveBeenCalledTimes(1); // 미리보기만
    expect(host.textContent).toContain("지금은 남기는 양을 줄일 수 없습니다");
  });

  it("목록 밖 값은 몰래 바꾸지 않고 무엇이 바뀌는지 묻는다 — 남기는 양은 더 남기는 쪽, 간격은 더 자주 찍는 쪽", async () => {
    api.backupPolicy.mockReset().mockResolvedValue({
      policy: { ...POLICY, quiet_minutes: 2, recent: 64 }, version: 0, source: "default", choices: CHOICES,
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    api.saveBackupPolicy
      .mockResolvedValueOnce({ saved: false, version: 0, preview: { delete_count: 0, confirm_token: null } })
      .mockResolvedValueOnce({ saved: true, version: 1, preview: { delete_count: 0 }, applied: { deleted: 0, failed: 0, blocked: null } });
    await mount();
    expect([...select("recent").options].map((o) => o.value)).toEqual(["64", "4", "8", "16"]); // 지금 값도 한 칸
    await choose("daily_days", 30);
    expect(confirm.mock.calls[0][0]).toContain("조용해진 뒤 2분 → 1분");
    expect(confirm.mock.calls[0][0]).toContain("최근 64장 → 16장");
    expect(api.saveBackupPolicy).not.toHaveBeenCalled(); // 거절하면 아무것도 안 보냄
    expect(host.textContent).toContain("바꾸지 않았습니다");
    await choose("daily_days", 30);
    expect(api.saveBackupPolicy.mock.calls[0][0]).toEqual({
      ...POLICY, quiet_minutes: 1, recent: 16, daily_days: 30, version: 0, dry_run: true,
    });
  });

  it("저장 메시지는 미리보기 수가 아니라 실제로 지운 수(applied)", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const preview = { delete_count: 6, delete_bytes: MB, confirm_token: "t", blocked: "inverted" };
    api.saveBackupPolicy
      .mockResolvedValueOnce({ saved: false, version: 1, preview })
      .mockResolvedValueOnce({ saved: true, version: 2, preview, applied: { deleted: 2, failed: 1, resume_failed: 4, blocked: null } });
    await mount();
    await choose("recent", 4);
    // 이어 지우기 실패(resume_failed)는 이번 대상의 보류 계산에 섞지 않는다
    expect(host.querySelector(".settings-backup .manage-msg")!.textContent).toBe(
      "저장했습니다 · 오래된 백업 2세트를 정리했습니다 · 1세트는 지우지 못했습니다(다음에 다시) · 3세트는 현재 정리 보류 중입니다",
    );
  });

  it("그사이 대상이 바뀌면(409 confirm_required) 다시 읽고 다시 고르라고 알린다", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    api.saveBackupPolicy
      .mockResolvedValueOnce({ saved: false, version: 1, preview: { delete_count: 1, confirm_token: "a" } })
      .mockRejectedValueOnce(new HttpError(409, "409: x", "지울 백업이 있어 확인이 필요합니다", { code: "confirm_required" }));
    await mount();
    await choose("daily_days", 7);
    expect(api.backupPolicy).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain("그사이 백업이 늘어 지울 것이 바뀌었습니다");
  });

  it("공유 서버(403) — 고르는 칸을 잠그고 까닭을 보인다", async () => {
    api.backupPolicy.mockReset().mockRejectedValue(
      new HttpError(403, "403: x", "공유 서버에서는 보관 양을 바꾸지 않습니다", { code: "local_hub_only" }));
    await mount();
    expect(select("recent").disabled).toBe(true);
    expect(host.textContent).toContain("공유 서버에서는 보관 양을 바꾸지 않습니다");
  });

  it("[지금 백업] — 찍은 뒤 현황을 다시 읽는다", async () => {
    api.backupNow.mockResolvedValue({ ok: true, file: "content_hub_x.db" });
    const onRefresh = await mount();
    const button = [...host.querySelectorAll<HTMLButtonElement>(".settings-action")].find((b) => b.textContent === "지금 백업")!;
    await act(async () => button.click());
    await flush();
    expect(api.backupNow).toHaveBeenCalledTimes(1);
    expect(onRefresh).toHaveBeenCalled();
    expect(host.textContent).toContain("지금 상태를 백업했습니다");
  });
});
