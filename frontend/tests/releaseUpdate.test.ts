import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getReleaseUpdateStatus,
  isReleaseUpdateRunning,
  startReleaseUpdate,
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
        body: JSON.stringify({ confirm: true }),
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
