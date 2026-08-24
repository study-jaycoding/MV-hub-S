import { describe, expect, it, vi } from "vitest";
import { announceAcceptedResolveTransfer } from "../src/lib/useResolveTransferActions";
import type { ResolveTransferAccepted } from "../src/lib/resolveTransfer";

describe("Resolve 접수 뒤 큐 갱신", () => {
  it("첫 전송 접수 안내 직후 큐를 다시 읽는다", async () => {
    const accepted: ResolveTransferAccepted = {
      transfer_id: "t1",
      project_id: "p1",
      project_name: "P1",
      queued: true,
      ahead: 0,
      queue: { state: "queued", dispatch_policy: "auto" },
      resolve_target: { project_id: "resolve-1", project_name: "편집 프로젝트" },
      status: "pending",
      total: 2,
      worker_enabled: true,
    };
    const flash = vi.fn();
    const refresh = vi.fn().mockResolvedValue([]);

    await announceAcceptedResolveTransfer(accepted, flash, refresh);

    expect(flash).toHaveBeenCalledOnce();
    expect(flash.mock.calls[0][0]).toContain("대기열");
    expect(refresh).toHaveBeenCalledOnce();
    expect(flash.mock.invocationCallOrder[0]).toBeLessThan(
      refresh.mock.invocationCallOrder[0],
    );
  });
});
