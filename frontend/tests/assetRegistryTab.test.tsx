// 관리자 창 · 에셋 대장 탭(2026-09-30) — 상태 표, 훑는 곳(서버 / 로컬 · 이 PC) 선택, [지금 훑기] 두 단계 확인.
// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AssetRegistryStatus } from "../src/lib/assetRegistryApi";

const status = vi.fn();
const scan = vi.fn();
const setMode = vi.fn();
const helperScan = vi.fn();
const helperStatus = vi.fn();
vi.mock("../src/lib/assetRegistryApi", () => ({
  assetRegistryApi: {
    status: () => status(),
    scan: () => scan(),
    setMode: (mode: string) => setMode(mode),
    helperScan: () => helperScan(),
    helperStatus: () => helperStatus(),
  },
}));
const { AssetRegistryTab } = await import("../src/components/admin/AssetRegistryTab");

let host: HTMLDivElement;
let root: Root;

const row = {
  project_id: "p1", name: "뻘뻘뻘", root: null, state: "ok", started_at: null,
  finished_at: "2026-09-30T03:38:14Z", complete: 1, clean: 1, files: 801, hashed: 801,
  hashed_bytes: 5_060_000_000, undetermined: 0, pending: 0, elapsed_ms: 647_270, note: null,
};
const base: AssetRegistryStatus = {
  enabled: true,
  mode: "server",
  interval_min: 0,
  running: false,
  current: {},
  last: {},
  projects: [row],
  counts: { p1: { present: 801 } },
  waiting_large: {},
};
const local: AssetRegistryStatus = { ...base, mode: "local", lease: null };

async function mount(): Promise<void> {
  await act(async () => root.render(<AssetRegistryTab />));
  await act(async () => undefined);
}

async function remount(): Promise<void> {
  act(() => root.unmount());
  root = createRoot(host);
  await mount();
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  for (const fn of [status, scan, setMode, helperScan, helperStatus]) fn.mockReset();
});

const idleHelper = { running: false, current: {}, last: {}, results: [], abort: "", available: true };
const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === text);
const buttons = () => [...host.querySelectorAll("button")].map((b) => b.textContent);

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

it("서버를 고르면 표를 보이고, [지금 훑기]는 한 번 더 확인한 뒤 서버 훑기를 시작한다", async () => {
  status.mockResolvedValue(base);
  scan.mockResolvedValue({ started: true });
  await mount();
  expect(host.textContent).toContain("뻘뻘뻘");
  expect(host.textContent).toContain("5.1 GB");
  expect(host.textContent).toContain("10분 47초");
  expect(button("서버")?.getAttribute("aria-pressed")).toBe("true");
  expect(helperStatus).not.toHaveBeenCalled(); // 서버일 때는 이 PC 도우미를 묻지 않는다

  await act(async () => button("지금 훑기")!.click());
  expect(scan).not.toHaveBeenCalled(); // 바로 시작하지 않는다
  await act(async () => button("시작")!.click());
  expect(scan).toHaveBeenCalledTimes(1);
  expect(helperScan).not.toHaveBeenCalled();
});

it("로컬을 고르면 같은 [지금 훑기]가 이 PC 로 훑는다 — 이 PC 가 도우미가 될 수 없으면 단추 대신 이유", async () => {
  status.mockResolvedValue(local);
  helperStatus.mockResolvedValue(idleHelper);
  helperScan.mockResolvedValue({ started: true });
  await mount();
  expect(button("로컬 · 이 PC")?.getAttribute("aria-pressed")).toBe("true");
  expect(host.textContent).toContain("자동 없음(로컬은 수동만)");
  await act(async () => button("지금 훑기")!.click());
  await act(async () => button("시작")!.click());
  expect(helperScan).toHaveBeenCalledTimes(1);
  expect(scan).not.toHaveBeenCalled();

  helperStatus.mockResolvedValue({ ...idleHelper, available: false }); // dev·격리 서버 = 자기 자신이 서버
  await remount();
  expect(buttons()).not.toContain("지금 훑기");
  expect(host.textContent).toContain("공유 서버에 로그인한 앱에서만 이 PC 로 훑을 수 있습니다");

  helperStatus.mockRejectedValue(new Error("404")); // 이 PC 허브가 없다(서버 화면을 원격으로 염)
  await remount();
  expect(buttons()).not.toContain("지금 훑기");
});

it("훑는 곳을 누르면 서버에 저장하고 다시 읽는다 — 고른 쪽을 다시 눌러도 아무것도 안 한다", async () => {
  status.mockResolvedValue(base);
  setMode.mockResolvedValue({ mode: "local" });
  await mount();
  await act(async () => button("서버")!.click());
  expect(setMode).not.toHaveBeenCalled();
  status.mockResolvedValue(local);
  helperStatus.mockResolvedValue(idleHelper);
  await act(async () => button("로컬 · 이 PC")!.click());
  expect(setMode).toHaveBeenCalledWith("local");
  expect(host.textContent).toContain("훑는 곳을 로컬 · 이 PC로 바꿨습니다");
  expect(button("로컬 · 이 PC")?.getAttribute("aria-pressed")).toBe("true");
});

it("꺼져 있으면 켜는 법만 · 옛 dev 서버(mode 없음)면 업데이트 안내 · 도는 중에는 단추가 없고 고르기도 막힌다", async () => {
  status.mockResolvedValue({ ...base, enabled: false, projects: [] });
  await mount();
  expect(host.textContent).toContain("CONTENT_HUB_ASSET_REGISTRY=1");
  expect(buttons()).toEqual([]);

  status.mockResolvedValue({ ...base, mode: undefined });
  await remount();
  expect(host.textContent).toContain("공유 서버 업데이트가 필요합니다");
  expect(buttons()).toEqual([]);

  status.mockResolvedValue({ ...base, running: true, current: { name: "산해학원", phase: "scan" } });
  await remount();
  expect(host.textContent).toContain("훑는 중: 산해학원");
  expect(buttons()).not.toContain("지금 훑기");
  expect(button("로컬 · 이 PC")?.disabled).toBe(true);

  status.mockResolvedValue({ ...local, lease: { project_id: "p1", name: "뻘뻘뻘", started_at: "2026-09-30T05:00:00Z" } });
  helperStatus.mockResolvedValue({
    ...idleHelper,
    abort: "로그인이 바뀌어 멈췄습니다",
    results: [{ project_id: "p1", name: "뻘뻘뻘", state: "failed", note: "이 PC 의 드라이브가 서버가 아는 공유 주소와 다릅니다" }],
  });
  await remount();
  expect(host.textContent).toContain("도우미 PC 가 훑는 중: 뻘뻘뻘");
  expect(buttons()).not.toContain("지금 훑기");
  expect(button("서버")?.disabled).toBe(true);
  expect(host.textContent).toContain("로그인이 바뀌어 멈췄습니다");
  expect(host.textContent).toContain("뻘뻘뻘 실패(이 PC 의 드라이브가 서버가 아는 공유 주소와 다릅니다)");
});

it("서버가 루트를 못 열었으면 로컬로 바꾸라고 알리고, 다른 실패는 원인만 보인다(NAS 권한 탓이라 단정하지 않는다)", async () => {
  status.mockResolvedValue({
    ...base,
    projects: [
      { ...row, state: "failed", note: "루트 폴더를 열 수 없음" },
      { ...row, project_id: "p2", name: "RnD", state: "failed", note: "시간 초과 — 자식을 끝냄" },
    ],
  });
  await mount();
  const warns = [...host.querySelectorAll(".admin-registry-warn")].map((w) => w.textContent);
  expect(warns[0]).toContain("서버가 NAS 를 열지 못했습니다(뻘뻘뻘 — 루트 폴더를 열 수 없음)");
  expect(warns[0]).toContain("로컬 · 이 PC 로 바꿔");
  expect(warns[1]).toBe("서버 훑기 실패 — RnD(시간 초과 — 자식을 끝냄)");

  status.mockResolvedValue({ ...local, projects: [{ ...row, state: "failed", note: "루트 폴더를 열 수 없음" }] });
  helperStatus.mockResolvedValue(idleHelper);
  await remount();
  expect(host.querySelectorAll(".admin-registry-warn")).toHaveLength(0); // 이미 로컬이면 알리지 않는다
});
