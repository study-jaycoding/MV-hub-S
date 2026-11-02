// @vitest-environment jsdom
// 옮겼지만 파일이 다른 PC 로 간다고 확인하지 못한 것 — 이동은 그대로 되고 성공 문구에 붙여 한 번에 알린다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const assign = vi.hoisted(() => vi.fn());
vi.mock("../src/api", () => ({ api: { assignProject: assign } }));
vi.mock("../src/lib/libraryBroadcast", () => ({ postLibraryChanged: () => {} }));

import { deliveryNotices, useGenerationProjectActions } from "../src/lib/useGenerationProjectActions";

let host: HTMLDivElement;
let root: Root;
let flash: ReturnType<typeof vi.fn>;
let move: (projectId: string | null) => Promise<void>;

function Probe() {
  const actions = useGenerationProjectActions({
    bumpBoard: () => {}, filtersRef: { current: { tab: "my" } as never }, flash, reload: async () => {}, selectedRef: { current: new Set(["g1"]) },
  });
  move = actions.assignSelectedToProject;
  return null;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  flash = vi.fn();
  assign.mockReset();
  act(() => root.render(<Probe />));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("이동 알림", () => {
  it("문제가 없으면 성공 문구만 뜬다", async () => {
    assign.mockResolvedValue({ ok: true, updated: 1, team_synced: null });
    await act(() => move("p1"));
    expect(flash).toHaveBeenCalledTimes(1);
    expect(flash.mock.calls[0][0]).toBe("1개를 프로젝트에 담았습니다.");
  });

  it("서버에 못 물었으면 성공 문구에 붙여 한 번에 알린다", async () => {
    assign.mockResolvedValue({ ok: true, updated: 1, team_synced: null, delivery_unverified: true });
    await act(() => move("p1"));
    expect(flash).toHaveBeenCalledTimes(1);
    expect(flash.mock.calls[0][0]).toContain("1개를 프로젝트에 담았습니다.");
    expect(flash.mock.calls[0][0]).toContain("파일 전달을 확인하지 못했습니다");
  });

  it("이 PC 에 없는 파일 수를 알린다", async () => {
    assign.mockResolvedValue({ ok: true, updated: 2, team_synced: null, missing_files: 3 });
    await act(() => move("p1"));
    expect(flash.mock.calls[0][0]).toContain("이 PC 에 없는 파일 3개");
  });

  it("옛 서버·없는 응답은 조용하다", () => {
    expect(deliveryNotices(undefined)).toEqual([]);
    expect(deliveryNotices({ missing_files: 0, delivery_unverified: false })).toEqual([]);
  });
});
