// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MountManager } from "../src/components/assets/MountManager";
import { assetsApi } from "../src/lib/assetsApi";

const mocks = vi.hoisted(() => ({ assetMounts: vi.fn(), addAssetMount: vi.fn(), confirmAssetMount: vi.fn(), delAssetMount: vi.fn() }));
vi.mock("../src/api", () => ({ api: mocks }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
const candidate = { name: "shots", path: "D:/shots", exists: true, restore_state: "pending" };
const flush = async () => { for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const show = async (team = "team-a") => {
  act(() => root.render(<MountManager workspaceId={team} onClose={() => {}} onChanged={() => {}} />));
  await flush();
};
const confirm = () => host.querySelector<HTMLButtonElement>('button[aria-label="shots 경로 확인"]')!;
const type = (selector: string, value: string) => act(() => {
  const field = host.querySelector<HTMLInputElement>(selector)!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
});
beforeEach(() => {
  vi.resetAllMocks();
  sessionStorage.setItem("ch.accountScope", "restore@example.invalid");
  mocks.assetMounts.mockResolvedValue({ mounts: [candidate], restore_id: "restore-1", restore_invalid: false });
  mocks.confirmAssetMount.mockResolvedValue({});
  mocks.addAssetMount.mockResolvedValue({});
  mocks.delAssetMount.mockResolvedValue({});
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it("경로 확인은 현재 복원 ID와 화면 경로를 전달하고 성공한 행만 확인 완료로 읽는다", async () => {
  await show();
  expect(host.textContent).toContain("확인 대기");
  expect(mocks.confirmAssetMount).not.toHaveBeenCalled();
  mocks.assetMounts.mockResolvedValue({ mounts: [{ ...candidate, restore_state: "confirmed" }], restore_id: "restore-1" });
  act(() => { confirm().click(); confirm().click(); });
  await flush();
  expect(mocks.confirmAssetMount).toHaveBeenCalledExactlyOnceWith("shots", "D:/shots", "restore-1");
  expect(host.textContent).toContain("확인 완료");
  expect(host.textContent).toContain("경로를 확인했습니다");
});

it("확인 실패는 성공으로 표시하지 않고 새 세대 정보를 다시 읽어 다음 확인에 쓴다", async () => {
  await show();
  mocks.confirmAssetMount.mockRejectedValueOnce(new Error("409 복원이 다시 진행됐습니다"));
  mocks.assetMounts.mockResolvedValue({ mounts: [candidate], restore_id: "restore-2" });
  act(() => confirm().click()); await flush();
  expect(host.textContent).toContain("확인 대기");
  expect(host.textContent).not.toContain("경로를 확인했습니다");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("409");
  act(() => confirm().click()); await flush();
  expect(mocks.confirmAssetMount.mock.calls[1]).toEqual(["shots", "D:/shots", "restore-2"]);
});

it("손상된 확인 정보와 읽기 실패는 등록·확인을 잠그고 재시도 입구를 남긴다", async () => {
  mocks.assetMounts.mockResolvedValue({ mounts: [candidate], restore_id: "", restore_invalid: true });
  await show();
  expect(confirm().disabled).toBe(true);
  expect(host.querySelector<HTMLButtonElement>(".mount-form .settings-action")!.disabled).toBe(true);
  expect(host.textContent).toContain("확인 정보를 읽을 수 없습니다");
  mocks.assetMounts.mockRejectedValue(new Error("offline"));
  act(() => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "목록 다시 확인")!.click());
  await flush();
  expect(host.textContent).toContain("폴더 상태를 읽지 못했습니다");
  expect(confirm().disabled).toBe(true);
});

it("없는 경로는 새 경로를 직접 입력하고 등록해야 연결하며 원래 이름과 현재 복원 ID를 보낸다", async () => {
  mocks.assetMounts.mockResolvedValue({ mounts: [{ ...candidate, exists: false, restore_state: "failed" }], restore_id: "restore-1" });
  await show();
  act(() => host.querySelector<HTMLButtonElement>('button[aria-label="shots 경로 다시 선택"]')!.click());
  expect(host.querySelector<HTMLInputElement>(".mount-name")!.value).toBe("shots");
  expect(mocks.addAssetMount).not.toHaveBeenCalled();
  type(".mount-input:not(.mount-name)", "E:/new-shots");
  act(() => host.querySelector<HTMLButtonElement>(".mount-form .settings-action")!.click());
  await flush();
  expect(mocks.addAssetMount).toHaveBeenCalledExactlyOnceWith("shots", "E:/new-shots", "restore-1");
});

it("다른 공간으로 바뀐 뒤 늦은 확인 응답은 새 공간에 성공 안내를 남기지 않는다", async () => {
  let done!: () => void;
  mocks.confirmAssetMount.mockReturnValue(new Promise<void>((resolve) => { done = resolve; }));
  await show(); act(() => confirm().click());
  mocks.assetMounts.mockResolvedValue({ mounts: [], restore_id: "restore-2" });
  await show("team-b");
  act(() => done()); await flush();
  expect(host.textContent).not.toContain("경로를 확인했습니다");
  expect(host.querySelector(".mount-item")).toBeNull();
  expect(mocks.assetMounts).toHaveBeenLastCalledWith("team-b");
});

it("실제 HTTP 래퍼가 재연결 ID와 확인 경로를 JSON으로 보낸다", async () => {
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ mounts: [] }), { status: 200, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetch);
  await assetsApi.confirmAssetMount("shots", "D:/shots", "restore-1");
  await assetsApi.addAssetMount("shots", "E:/shots", "restore-2");
  expect(fetch.mock.calls.map((call) => call[0])).toEqual(["/api/assets/mounts/confirm", "/api/assets/mounts"]);
  const options = fetch.mock.calls.map((call) => call[1] as RequestInit);
  expect(options.map((o) => JSON.parse(o.body as string))).toEqual([
    { name: "shots", path: "D:/shots", restore_id: "restore-1" },
    { name: "shots", path: "E:/shots", restore_id: "restore-2" },
  ]);
  await assetsApi.delAssetMount("shots", { path: "D:/shots #1", restore_id: "restore-1" });
  const deleted = new URL(fetch.mock.calls[2][0], "http://localhost");
  expect(deleted.pathname).toBe("/api/assets/mounts/shots");
  expect(Object.fromEntries(deleted.searchParams)).toEqual({ path: "D:/shots #1", restore_id: "restore-1" });
  expect(fetch.mock.calls[2][1]?.method).toBe("DELETE");
});

it("같은 이름의 후보가 둘이면 확인한 경로의 해제만 노출하고 현재 쌍을 전달한다", async () => {
  vi.stubGlobal("confirm", () => true);
  mocks.assetMounts.mockResolvedValue({ mounts: [
    { ...candidate, restore_state: "confirmed" }, { ...candidate, path: "E:/other" },
  ], restore_id: "restore-1" });
  await show();
  expect(host.querySelectorAll(".mount-item")).toHaveLength(2);
  expect(host.querySelectorAll(".mount-del")).toHaveLength(1);
  act(() => host.querySelector<HTMLButtonElement>(".mount-del")!.click()); await flush();
  expect(mocks.delAssetMount).toHaveBeenCalledExactlyOnceWith("shots", { path: "D:/shots", restore_id: "restore-1" });
});

it("일반 모드에서 없는 폴더도 기존 이름으로 등록을 해제한다", async () => {
  vi.stubGlobal("confirm", () => true);
  mocks.assetMounts.mockResolvedValue({ mounts: [{ name: "shots", path: "D:/shots", exists: false }] });
  await show();
  expect(host.textContent).not.toContain("확인 완료");
  expect(host.textContent).not.toContain("연결 실패");
  const remove = host.querySelector<HTMLButtonElement>(".mount-del")!;
  expect(remove).not.toBeNull();
  expect(remove.disabled).toBe(false);
  act(() => remove.click()); await flush();
  expect(mocks.delAssetMount).toHaveBeenCalledExactlyOnceWith("shots");
});

it("확인했던 폴더가 사라져도 현재 복원 ID와 경로로 등록을 해제한다", async () => {
  vi.stubGlobal("confirm", () => true);
  mocks.assetMounts.mockResolvedValue({ mounts: [{ ...candidate, exists: false, restore_state: "failed" }], restore_id: "restore-1" });
  await show();
  expect(host.textContent).toContain("연결 실패");
  const remove = host.querySelector<HTMLButtonElement>(".mount-del")!;
  expect(remove).not.toBeNull();
  act(() => remove.click()); await flush();
  expect(mocks.delAssetMount).toHaveBeenCalledExactlyOnceWith("shots", { path: "D:/shots", restore_id: "restore-1" });
});
