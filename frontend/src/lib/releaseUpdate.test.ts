// 업데이트 폴링 안내 문구 계약 — 유령 진행률(멈춘 75%) 방지의 경계값과
// 실패 상태 메시지(recovery별)를 고정한다. 2026-09-02 실측 장애의 재발 방지.
import { describe, expect, it } from "vitest";
import {
  UPDATE_UNREACHABLE_WARN_MS,
  pollFailureMessage,
  releaseUpdateMessage,
  type ReleaseUpdateStatus,
} from "./releaseUpdate";

function failedStatus(overrides: Partial<ReleaseUpdateStatus> = {}): ReleaseUpdateStatus {
  return {
    state: "failed",
    message: "Update failed: swap died",
    install_mode: "release",
    current_version: "1.0.0",
    latest_version: "1.1.0",
    can_update: true,
    generation_active: 0,
    comfy_active: 0,
    resolve_active: 0,
    active_total: 0,
    updated_at: "2026-09-02T00:00:00+00:00",
    ...overrides,
  };
}

describe("pollFailureMessage", () => {
  it("연속 실패가 없으면 안내하지 않는다", () => {
    expect(pollFailureMessage(null, 1_000_000)).toBeNull();
  });

  it("90초 직전까지는 재시작 구간으로 보고 직전 문구를 유지한다", () => {
    const start = 1_000_000;
    expect(pollFailureMessage(start, start + UPDATE_UNREACHABLE_WARN_MS - 1)).toBeNull();
  });

  it("90초부터는 멈춘 진행률 대신 대기 안내로 바꾼다 — 직접 실행 유도는 금지", () => {
    const start = 1_000_000;
    const message = pollFailureMessage(start, start + UPDATE_UNREACHABLE_WARN_MS);
    expect(message).toContain("90초");
    // 업데이터가 아직 롤백·복사 중일 수 있다 — 앱을 직접 띄우게 하면 2차 잠금을 만든다.
    expect(message).toContain("직접 실행하지 말");
    expect(message).not.toContain("MV_agent");
  });
});

describe("releaseUpdateMessage — 실패 상태", () => {
  it("일반 실패는 한글 접두 + 원문을 보존한다", () => {
    const text = releaseUpdateMessage(failedStatus());
    expect(text).toBe("업데이트 실패: Update failed: swap died");
  });

  it("recovery_required 는 재시도 대신 로그 확인을 안내한다", () => {
    const text = releaseUpdateMessage(failedStatus({ recovery: "recovery_required" }));
    expect(text).toContain("자동 복구가 완료되지 않았습니다");
    expect(text).toContain("update.log");
  });

  it("rolled_back 은 일반 실패와 같은 문구다(구버전으로 복원됨 — 재시도 가능)", () => {
    const text = releaseUpdateMessage(failedStatus({ recovery: "rolled_back" }));
    expect(text).toBe("업데이트 실패: Update failed: swap died");
  });
});
