import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getReleaseUpdateStatus,
  isReleaseUpdateRunning,
  startReleaseUpdate,
  updateBlockersText,
  type ReleaseUpdateStatus,
} from "../src/lib/releaseUpdate";

const status: ReleaseUpdateStatus = {
  state: "available",
  message: "업데이트 가능",
  install_mode: "release",
  current_version: "1.0.0",
  latest_version: "1.1.0",
  can_update: true,
  generation_active: 0,
  comfy_active: 0,
  resolve_active: 0,
  active_total: 0,
  updated_at: "2026-08-14T00:00:00Z",
};

afterEach(() => vi.unstubAllGlobals());

describe("작업자 릴리스 업데이트 API", () => {
  it("다시 확인할 때 릴리스 서버 새로고침을 요청한다", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers(),
      json: vi.fn().mockResolvedValue(status),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(getReleaseUpdateStatus(true)).resolves.toEqual(status);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/release-update/status?refresh=true",
      expect.objectContaining({ headers: expect.any(Object) }),
    );
  });

  it("명시적 확인값과 전용 헤더로만 업데이트를 시작한다", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers(),
      json: vi.fn().mockResolvedValue({ ...status, state: "starting", accepted: true }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await startReleaseUpdate();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/release-update/start",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "X-MVHub-Update": "1" }),
        body: JSON.stringify({ confirm: true, force: false }),
      }),
    );
  });

  it("강제 시작은 force=true 를 싣는다 — 진행 중 검사 건너뛰기(오류 잔여 카드 우회)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers(),
      json: vi.fn().mockResolvedValue({ ...status, state: "starting", accepted: true }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await startReleaseUpdate(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/release-update/start",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "X-MVHub-Update": "1" }),
        body: JSON.stringify({ confirm: true, force: true }),
      }),
    );
  });

  it("교체와 재시작 단계만 진행 중으로 판단한다", () => {
    expect(isReleaseUpdateRunning("checking")).toBe(true);
    expect(isReleaseUpdateRunning("installing")).toBe(true);
    expect(isReleaseUpdateRunning("restarting")).toBe(true);
    expect(isReleaseUpdateRunning("available")).toBe(false);
    expect(isReleaseUpdateRunning("failed")).toBe(false);
  });
});

describe("업데이트 차단 사유 문구", () => {
  it("유료 생성과 Resolve 전송을 나눠 말하고, 없으면 빈 문자열이다", () => {
    expect(updateBlockersText({ active_total: 2, resolve_active: 0 })).toBe("생성 2건");
    expect(updateBlockersText({ active_total: 1, resolve_active: 1 })).toBe("Resolve 전송 1건");
    expect(updateBlockersText({ active_total: 3, resolve_active: 1 })).toBe(
      "생성 2건 · Resolve 전송 1건",
    );
    expect(updateBlockersText({ active_total: 0, resolve_active: 0 })).toBe("");
    expect(updateBlockersText(null)).toBe("");
  });
});
