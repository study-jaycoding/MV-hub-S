// @vitest-environment jsdom
// 코멘트 그림의 저장 문맥 — auth_enabled × shared_team_server 세 모드, 중계 여부 = 실제 proxying(has_token 아님), 기대값,
//  서버 능력 조회(실패 = 안 받음, 문맥별 기억). 설계 docs/status/어셋코멘트그림_설계_2026-11-05.md §3.2·§4.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  authConfig: vi.fn(),
  sharedServerStatus: vi.fn(),
  shareCapabilities: vi.fn(),
}));
vi.mock("../src/api", () => ({ api: calls }));

import { setAccountScope } from "../src/lib/accountScope";
import {
  ASSET_DRAWING_FEATURE, clearAssetDrawingSupportCache, expectationFor, loadCommentWriteContext, previewShowsTarget, sameCommentTarget,
  serverAcceptsAssetDrawings,
} from "../src/lib/commentTarget";
import { assetFileUrl } from "../src/lib/assetUrls";
import { setHubFeatures } from "../src/lib/hubFeatures";

const status = (over: Record<string, unknown>) => ({ configured: true, url: "http://srv:8010/", email: "U1@Example.com", has_token: true, ...over });

beforeEach(() => {
  Object.values(calls).forEach((fn) => fn.mockReset());
  clearAssetDrawingSupportCache();
  localStorage.clear();
});
afterEach(() => setHubFeatures([]));

describe("저장 문맥", () => {
  it("허브 — 토큰이 있어도 proxying=false(NO_PROXY)면 공유도 로컬에 쓴다", async () => {
    calls.authConfig.mockResolvedValue({ auth_enabled: false, has_accounts: true, features: [ASSET_DRAWING_FEATURE] });
    calls.sharedServerStatus.mockResolvedValue(status({ proxying: false }));
    const ctx = (await loadCommentWriteContext())!;
    expect([ctx.mode, ctx.proxying, ctx.allowPrivate]).toEqual(["hub", false, true]);
    expect(expectationFor(ctx, false)).toEqual({ expected_target: "local", expected_server_url: null, expected_server_account: null });
  });

  it("허브 중계 중 — 공유 = 서버(주소·계정), 비공개 = 로컬", async () => {
    calls.authConfig.mockResolvedValue({ auth_enabled: false, has_accounts: true, features: [] });
    calls.sharedServerStatus.mockResolvedValue(status({ proxying: true }));
    const ctx = (await loadCommentWriteContext())!;
    expect(expectationFor(ctx, false)).toEqual({ expected_target: "server", expected_server_url: "http://srv:8010", expected_server_account: "u1@example.com" });
    expect(expectationFor(ctx, true).expected_target).toBe("local");
  });

  it("로그인 켬 + 본체 = 서버 직결(비공개 없음) · 로그인 켬 + 본체 아님 = 격리 로컬(dev)", async () => {
    setAccountScope("u1@example.com");
    calls.authConfig.mockResolvedValue({ auth_enabled: true, has_accounts: true, shared_team_server: true });
    const server = (await loadCommentWriteContext())!;
    expect([server.mode, server.allowPrivate, server.expectAccount]).toEqual(["server", false, "acct:u1@example.com"]);
    expect(expectationFor(server, false)).toEqual({ expected_target: "server", expected_server_url: null, expected_server_account: "u1@example.com" });
    calls.authConfig.mockResolvedValue({ auth_enabled: true, has_accounts: true, shared_team_server: false });
    const isolated = (await loadCommentWriteContext())!;
    expect([isolated.mode, isolated.allowPrivate]).toEqual(["isolated", true]);
    expect(expectationFor(isolated, false).expected_target).toBe("local");
    expect(calls.sharedServerStatus).not.toHaveBeenCalled(); // 루프백 전용 상태 API 는 허브 화면만 묻는다
  });

  it("상태를 읽지 못하면 준비 안 됨(로컬로 보지 않는다)", async () => {
    calls.authConfig.mockResolvedValue({ auth_enabled: false, has_accounts: true });
    calls.sharedServerStatus.mockRejectedValue(new Error("down"));
    expect(await loadCommentWriteContext()).toBeNull();
  });
});

describe("서버 능력(어셋 그림)", () => {
  const hub = async (proxying: boolean) => {
    calls.authConfig.mockResolvedValue({ auth_enabled: false, has_accounts: true, features: [ASSET_DRAWING_FEATURE] });
    calls.sharedServerStatus.mockResolvedValue(status({ proxying }));
    return (await loadCommentWriteContext())!;
  };

  it("허브 표식이 없으면 안 보임 · 서버 없는 허브는 허브 표식만", async () => {
    const local = await hub(false);
    expect(await serverAcceptsAssetDrawings(local)).toBe(true);
    expect(calls.shareCapabilities).not.toHaveBeenCalled();
    setHubFeatures([]);
    expect(await serverAcceptsAssetDrawings(local)).toBe(false);
  });

  it("중계 중이면 서버 표식 — 성공만 기억, 실패(옛 서버·권한·연결)는 숨기고 다음에 다시 묻는다", async () => {
    const ctx = await hub(true);
    calls.shareCapabilities.mockRejectedValueOnce(new Error("404"));
    expect(await serverAcceptsAssetDrawings(ctx)).toBe(false);
    calls.shareCapabilities.mockResolvedValueOnce({ share_command: 1 });
    expect(await serverAcceptsAssetDrawings(ctx)).toBe(false); // 칸 없음 = 옛 서버
    clearAssetDrawingSupportCache();
    calls.shareCapabilities.mockResolvedValueOnce({ asset_comment_drawings: 1 });
    expect(await serverAcceptsAssetDrawings(ctx)).toBe(true);
    expect(await serverAcceptsAssetDrawings(ctx)).toBe(true);
    expect(calls.shareCapabilities).toHaveBeenCalledTimes(3); // 마지막은 기억한 값
  });
});

describe("대상 짝", () => {
  it("생성물은 genId, 어셋은 경로 + 그 프로젝트의 파일 주소", () => {
    const asset = { kind: "asset" as const, project: "P", path: "a/b.mp4" };
    expect(sameCommentTarget(asset, { ...asset })).toBe(true);
    expect(sameCommentTarget(asset, { kind: "generation", genId: "a/b.mp4" })).toBe(false);
    expect(previewShowsTarget({ assetPath: "a/b.mp4", url: assetFileUrl("P", "a/b.mp4") }, asset)).toBe(true);
    expect(previewShowsTarget({ assetPath: "a/b.mp4", url: assetFileUrl("Q", "a/b.mp4") }, asset)).toBe(false); // 다른 프로젝트 같은 경로
    expect(previewShowsTarget({ genId: "g1", url: "/x" }, asset)).toBe(false);
    expect(previewShowsTarget({ genId: "g1", url: "/x" }, { kind: "generation", genId: "g1" })).toBe(true);
  });
});
