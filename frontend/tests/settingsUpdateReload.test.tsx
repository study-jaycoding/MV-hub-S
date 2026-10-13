// @vitest-environment jsdom
// 설정 창의 업데이트 폴 — 새 판이 되면 스스로 새로고침하되, 저장하지 못한 편집이 있으면 하지 않는다.
//
// 왜(Codex 재검토 3회째 2026-10-13): 업데이트 덮개는 저장하지 못한 편집이 있으면 [지금 새로고침]·[닫기]를 묻는데, 설정 창이 따로 도는
//  폴로 0.5초 뒤 묻지 않고 새로고침했다 — 덮개가 묻기도 전에 그 편집이 사라졌다. 두 곳이 같은 판정(lib/unloadGuard)을 쓴다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { UPDATE_WAIT_VERSION_KEY } from "../src/lib/releaseUpdate";
import { holdUnload } from "../src/lib/unloadGuard";

const mocks = vi.hoisted(() => ({ jsonFetch: vi.fn() }));
vi.mock("../src/lib/http", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  jsonFetch: (...args: unknown[]) => mocks.jsonFetch(...args),
}));
vi.mock("../src/api", () => {
  const stub = vi.fn().mockResolvedValue(null);
  return { api: new Proxy({}, { get: () => stub }) };
});

const { SettingsPanel } = await import("../src/components/SettingsPanel");

const DONE = {
  state: "complete", message: "", install_mode: "release", current_version: "2026.10.13-0900", latest_version: "2026.10.13-0900",
  can_update: false, generation_active: 0, comfy_active: 0, resolve_active: 0, active_total: 0, updated_at: "", percent: 100,
};

let container: HTMLDivElement;
let root: Root;
const reload = vi.fn();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("location", { href: "http://localhost:3000/", origin: "http://localhost:3000", protocol: "http:", host: "localhost:3000",
    hostname: "localhost", port: "3000", pathname: "/", search: "", hash: "", reload });
  reload.mockReset();
  mocks.jsonFetch.mockReset();
  // 업데이트 상태만 답한다 — 설정 창이 여는 순간 묻는 다른 것(Resolve 연결 등)은 실패로 둔다(그 모양의 답이 아니면 화면이 깨진다).
  mocks.jsonFetch.mockImplementation((url: string) =>
    url.startsWith("/api/release-update/status") ? Promise.resolve(DONE) : Promise.reject(new Error("offline")));
  window.sessionStorage.setItem(UPDATE_WAIT_VERSION_KEY, "2026.10.13-0900"); // 업데이트를 누른 뒤다 — 열자마자 폴이 돈다
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  holdUnload("edit-docs", false);
  window.sessionStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const open = async () => {
  act(() => root.render(<SettingsPanel onClose={() => {}} />));
  // 상태를 받고 → 폴을 켜고(다음 렌더의 효과) → 완료를 보고 → 0.5초 뒤. 효과는 act 가 끝나야 돌므로 여러 번에 나눠 흘린다.
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
  }
};

it("새 판이 되면 스스로 새로고침한다", async () => {
  await open();
  expect(reload).toHaveBeenCalledTimes(1);
});

it("저장하지 못한 편집이 있으면 새로고침하지 않고 알린다 — 폴도 멈춘다", async () => {
  holdUnload("edit-docs", true);
  await open();
  expect(reload).not.toHaveBeenCalled();
  expect(container.textContent).toContain("저장하지 못한 변경이 있어 자동으로 새로고침하지 않았습니다");
  mocks.jsonFetch.mockClear();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(mocks.jsonFetch.mock.calls.filter(([url]) => String(url).startsWith("/api/release-update/status"))).toHaveLength(0);
});
