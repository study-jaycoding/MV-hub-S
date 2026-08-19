import { afterEach, describe, expect, it, vi } from "vitest";

import { assetsApi, selectCurrentServerBackup } from "../src/lib/assetsApi";

function okResponse(result: unknown): Pick<Response, "ok" | "json"> {
  return { ok: true, json: vi.fn().mockResolvedValue(result) };
}

afterEach(() => vi.unstubAllGlobals());

describe("personal metadata backup API", () => {
  it("자동 동기화는 더 늦게 올라온 충돌본보다 서버 활성본을 선택한다", () => {
    const current = {
      name: "current",
      size: 10,
      mtime: 100,
      kind: "set" as const,
      is_current: true,
      branch_status: "current" as const,
    };
    const conflict = {
      name: "conflict",
      size: 10,
      mtime: 200,
      kind: "set" as const,
      is_current: false,
      branch_status: "conflict" as const,
    };

    expect(selectCurrentServerBackup([conflict, current])).toBe(current);
  });

  it("활성본 표식이 없는 구버전 목록은 가장 최근 세트를 선택한다", () => {
    const oldBackup = { name: "old", size: 10, mtime: 100, kind: "set" as const };
    const newBackup = { name: "new", size: 10, mtime: 200, kind: "set" as const };

    expect(selectCurrentServerBackup([oldBackup, newBackup])).toBe(newBackup);
  });

  it("서버 버전 목록은 읽기 전용 경로로 조회한다", async () => {
    const payload = { backups: [] };
    const fetchMock = vi.fn().mockResolvedValue(okResponse(payload));
    vi.stubGlobal("fetch", fetchMock);

    await expect(assetsApi.serverBackups()).resolves.toEqual(payload);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/db/server-backups",
      expect.objectContaining({ headers: expect.any(Object) }),
    );
  });

  it("사용자가 고른 백업 세트 ID만 인코딩해 적용한다", async () => {
    const payload = {
      ok: true,
      relogin_required: true,
      backup_set_id: "set/a b",
      continuity_updated: true,
      activation_synced: true,
    };
    const fetchMock = vi.fn().mockResolvedValue(okResponse(payload));
    vi.stubGlobal("fetch", fetchMock);

    await expect(assetsApi.serverRestore("set/a b")).resolves.toEqual(payload);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/db/server-restore/set%2Fa%20b",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
