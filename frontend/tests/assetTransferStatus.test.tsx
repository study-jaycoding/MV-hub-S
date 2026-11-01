// @vitest-environment jsdom
// 설정의 전송 상태 — 다른 PC 에서만 깨져 보이는 일을 작성자가 알 수 있는 자리.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const status = vi.hoisted(() => vi.fn());
const retry = vi.hoisted(() => vi.fn());
vi.mock("../src/api", () => ({ api: { assetSyncStatus: status, retryAssetSync: retry } }));

import { AssetTransferLine } from "../src/components/settings/SettingsSections";

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function show(summary: object | undefined) {
  status.mockResolvedValue({ items: [], summary });
  await act(async () => { root.render(<AssetTransferLine />); });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  status.mockReset();
  retry.mockReset();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("자료 전송 줄", () => {
  it("보낼 것이 없으면 그리지 않는다 · 옛 허브도 그렇다", async () => {
    await show({ waiting: 0, failed: 0, needs_check: 0 });
    expect(host.textContent).toBe("");
    await show(undefined);
    expect(host.textContent).toBe("");
  });

  it("대기만 있으면 단추가 없다", async () => {
    await show({ waiting: 2, failed: 0, needs_check: 0 });
    expect(host.textContent).toContain("대기 2");
    expect(host.querySelector("button")).toBeNull();
  });

  it("확인 필요만 있으면 단추가 없다 — 눌러도 안 줄어든다", async () => {
    await show({ waiting: 0, failed: 0, needs_check: 3 });
    expect(host.textContent).toContain("확인 필요 3");
    expect(host.querySelector("button")).toBeNull();
    expect(host.querySelector("[title]")?.getAttribute("title")).toContain("구성원");
  });

  it("실패가 있으면 다시 시도할 수 있고 눌러 받은 상태로 바뀐다", async () => {
    await show({ waiting: 0, failed: 1, needs_check: 0 });
    retry.mockResolvedValue({ items: [], summary: { waiting: 1, failed: 0, needs_check: 0 } });
    await act(async () => { host.querySelector("button")!.click(); });
    expect(retry).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("대기 1");
    expect(host.querySelector("button")).toBeNull();
  });

  it("상태를 못 읽으면 조용히 그리지 않는다", async () => {
    status.mockRejectedValue(new Error("no hub"));
    await act(async () => { root.render(<AssetTransferLine />); });
    expect(host.textContent).toBe("");
  });
});
