// 관리자 창 · 에셋 대장 탭(2026-09-30) — 상태 표와 [지금 훑기] 두 단계 확인.
// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AssetRegistryStatus } from "../src/lib/assetRegistryApi";

const status = vi.fn();
const scan = vi.fn();
const helperScan = vi.fn();
const helperStatus = vi.fn();
vi.mock("../src/lib/assetRegistryApi", () => ({
  assetRegistryApi: {
    status: () => status(),
    scan: () => scan(),
    helperScan: () => helperScan(),
    helperStatus: () => helperStatus(),
  },
}));
const { AssetRegistryTab } = await import("../src/components/admin/AssetRegistryTab");

let host: HTMLDivElement;
let root: Root;

const base: AssetRegistryStatus = {
  enabled: true,
  interval_min: 0,
  running: false,
  current: {},
  last: {},
  projects: [
    {
      project_id: "p1", name: "뻘뻘뻘", root: null, state: "ok", started_at: null,
      finished_at: "2026-09-30T03:38:14Z", complete: 1, clean: 1, files: 801, hashed: 801,
      hashed_bytes: 5_060_000_000, undetermined: 0, pending: 0, elapsed_ms: 647_270, note: null,
    },
  ],
  counts: { p1: { present: 801 } },
  waiting_large: {},
};

async function mount(): Promise<void> {
  await act(async () => root.render(<AssetRegistryTab />));
  await act(async () => undefined);
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  status.mockReset();
  scan.mockReset();
  helperScan.mockReset();
  helperStatus.mockReset();
});

const idleHelper = { running: false, current: {}, last: {}, results: [], abort: "" };
const buttons = () => [...host.querySelectorAll("button")].map((b) => b.textContent);

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

it("프로젝트별 마지막 훑기를 보이고, [지금 훑기]는 한 번 더 확인한 뒤에 시작한다", async () => {
  status.mockResolvedValue(base);
  scan.mockResolvedValue({ started: true });
  await mount();
  expect(host.textContent).toContain("뻘뻘뻘");
  expect(host.textContent).toContain("완료");
  expect(host.textContent).toContain("5.1 GB");
  expect(host.textContent).toContain("10분 47초");

  const button = [...host.querySelectorAll("button")].find((b) => b.textContent === "지금 훑기")!;
  await act(async () => button.click());
  expect(scan).not.toHaveBeenCalled(); // 바로 시작하지 않는다
  const start = [...host.querySelectorAll("button")].find((b) => b.textContent === "시작")!;
  await act(async () => start.click());
  expect(scan).toHaveBeenCalledTimes(1);
});

it("꺼져 있으면 켜는 법을 알리고 단추를 숨긴다 — 도는 중에도 단추가 없다", async () => {
  status.mockResolvedValue({ ...base, enabled: false, projects: [] });
  await mount();
  expect(host.textContent).toContain("CONTENT_HUB_ASSET_REGISTRY=1");
  expect([...host.querySelectorAll("button")].some((b) => b.textContent === "지금 훑기")).toBe(false);

  act(() => root.unmount());
  root = createRoot(host);
  status.mockResolvedValue({ ...base, running: true, current: { name: "산해학원", phase: "scan" } });
  await mount();
  expect(host.textContent).toContain("훑는 중: 산해학원");
  expect([...host.querySelectorAll("button")].some((b) => b.textContent === "지금 훑기")).toBe(false);
});

it("서버가 NAS 를 못 읽을 때(도우미만 켬) — 서버 [지금 훑기] 대신 [이 PC 에서 훑기]를 한 번 더 확인한 뒤 시작한다", async () => {
  status.mockResolvedValue({ ...base, enabled: false, helper_enabled: true, lease: null });
  helperStatus.mockResolvedValue(idleHelper);
  helperScan.mockResolvedValue({ started: true });
  await mount();
  expect(buttons()).not.toContain("지금 훑기");
  expect(host.textContent).toContain("뻘뻘뻘"); // 서버 표는 그대로 보인다
  const button = [...host.querySelectorAll("button")].find((b) => b.textContent === "이 PC 에서 훑기")!;
  await act(async () => button.click());
  expect(helperScan).not.toHaveBeenCalled();
  const start = [...host.querySelectorAll("button")].find((b) => b.textContent === "시작")!;
  await act(async () => start.click());
  expect(helperScan).toHaveBeenCalledTimes(1);
  expect(scan).not.toHaveBeenCalled();
});

it("다른 도우미 PC 가 훑는 중이면 알리고 어느 단추도 없다 — 이 PC 가 멈췄으면 이유를 보인다", async () => {
  status.mockResolvedValue({
    ...base,
    helper_enabled: true,
    lease: { project_id: "p1", name: "뻘뻘뻘", started_at: "2026-09-30T05:00:00Z" },
  });
  helperStatus.mockResolvedValue(idleHelper);
  await mount();
  expect(host.textContent).toContain("도우미 PC 가 훑는 중: 뻘뻘뻘");
  expect(buttons()).not.toContain("지금 훑기");
  expect(buttons()).not.toContain("이 PC 에서 훑기");

  act(() => root.unmount());
  root = createRoot(host);
  status.mockResolvedValue({ ...base, enabled: false, helper_enabled: true, lease: null });
  helperStatus.mockResolvedValue({
    ...idleHelper,
    abort: "로그인이 바뀌어 멈췄습니다",
    results: [{ project_id: "p1", name: "뻘뻘뻘", state: "failed", note: "이 PC 의 드라이브가 서버가 아는 공유 주소와 다릅니다" }],
  });
  await mount();
  expect(host.textContent).toContain("로그인이 바뀌어 멈췄습니다");
  expect(host.textContent).toContain("뻘뻘뻘 실패(이 PC 의 드라이브가 서버가 아는 공유 주소와 다릅니다)");
});
