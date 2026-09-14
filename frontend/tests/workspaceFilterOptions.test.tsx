// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 워크스페이스 목록 컨테이너 훅 — 툴바 필터의 칩 이름과 메뉴 항목이 여기서 나온다.
//
// ★목록은 `#+` 피커·씬 우클릭 메뉴와 **모듈 캐시 하나**를 나눠 쓴다. 그래서 "캐시가 이미 차 있다"
//  는 이유로 건너뛰기만 하면, 다른 피커가 채운 뒤에는 이름을 영영 못 가져와 칩이 '…' 로 굳는다.
//
// ★조회 실패는 '목록이 비었다'와 다르다. 실패했다고 목록을 비우면 화면이 "속한 공간이 없습니다"
//  로 바뀌어, 끊긴 것을 사용자가 자기 권한 문제로 오해한다.

const cached = vi.fn<[], { id: string; name: string }[] | null>(() => null);
const fetched = vi.fn<[], Promise<{ id: string; name: string }[]>>(() => Promise.resolve([]));

vi.mock("../src/lib/workspaceOptionsCache", () => ({
  cachedWorkspaceOptions: () => cached(),
  fetchWorkspaceOptions: () => fetched(),
}));

const { useWorkspaceFilterOptions } = await import("../src/lib/useWorkspaceFilterOptions");

const WS = [{ id: "ws-1", name: "뻘뻘뻘" }];

let host: HTMLDivElement;
let root: Root;
let seen: ReturnType<typeof useWorkspaceFilterOptions>;

function Probe({ active }: { active: boolean }) {
  seen = useWorkspaceFilterOptions(active);
  return null;
}

beforeEach(() => {
  cached.mockReset().mockReturnValue(null);
  fetched.mockReset().mockResolvedValue([]);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const render = (active: boolean) => act(() => root.render(<Probe active={active} />));

describe("워크스페이스 목록 훅", () => {
  it("걸려 있지 않으면 미리 받지 않는다", () => {
    render(false);
    expect(fetched).not.toHaveBeenCalled();
    expect(seen.options).toEqual([]);
  });

  it("걸려 있는데 캐시가 비었으면 받아온다", async () => {
    fetched.mockResolvedValue(WS);
    render(true);
    await act(async () => {});
    expect(fetched).toHaveBeenCalled();
    expect(seen.options).toEqual(WS);
  });

  it("다른 피커가 나중에 캐시를 채웠으면 조회 없이 그것을 쓴다", () => {
    render(false); // 필터 없이 시작 — 이때는 캐시가 비어 있었다
    cached.mockReturnValue(WS); // 그 뒤 #+ 피커가 공용 캐시를 채운다
    render(true); // 등록 침으로 필터를 건다
    expect(seen.options).toEqual(WS); // 칩이 '…' 로 굳지 않는다
    expect(fetched).not.toHaveBeenCalled();
  });

  it("조회에 실패하면 실패라고 알리고 목록은 건드리지 않는다", async () => {
    cached.mockReturnValue(WS);
    render(true);
    cached.mockReturnValue(null);
    fetched.mockRejectedValue(new Error("offline"));
    act(() => seen.reload());
    await act(async () => {});
    expect(seen.failed).toBe(true);
    expect(seen.options).toEqual(WS);
    expect(seen.loading).toBe(false);
  });
});
