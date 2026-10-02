// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HttpError } from "../src/lib/http";
import type { BackupReplicaStatus } from "../src/lib/backupReplicaApi";

const mocks = vi.hoisted(() => ({ status: vi.fn(), save: vi.fn(), run: vi.fn() }));
vi.mock("../src/lib/backupReplicaApi", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/backupReplicaApi")>();
  return { ...real, backupReplicaApi: { status: mocks.status, save: mocks.save, run: mocks.run } };
});

import { BackupReplicaSection, replicaView } from "../src/components/admin/BackupReplicaSection";

const base = (extra: Partial<BackupReplicaStatus> = {}): BackupReplicaStatus => ({
  applicable: true, target: "\\\\NAS\\backup\\mvhub", target_id: "aaa", source: "file", editable: true,
  lock_reason: null, target_garbled: false, target_is_unc: true, server_account_system: true,
  task: { exists: true, enabled: true, running: false, matches_install: true, ignore_new: true,
    last_run_at: "2026-10-02T03:30:00Z", last_result: 0, next_run_at: null },
  result: { state: "success", error_code: null, target_id: "aaa", started_at: "2026-10-02T03:30:01Z",
    last_attempt_at: "2026-10-02T03:31:00Z", last_success_at: "2026-10-02T03:31:00Z", copied: 3, skipped: 12, failed: 0 },
  ...extra,
});

let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.values(mocks).forEach((m) => m.mockReset());
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const mount = async () => { await act(async () => { root.render(<BackupReplicaSection />); }); await act(async () => {}); };
const button = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === label)!;

it("결과 상자: 성공·0건·다른 위치·실패를 구별한다", () => {
  expect(replicaView(base(), false)).toMatchObject({ tone: "ok" });
  expect(replicaView(base({ result: { ...base().result!, copied: 0, skipped: 0 } }), false).head).toContain("복사할 백업 파일 없음");
  expect(replicaView(base({ target_id: "bbb" }), false)).toMatchObject({ tone: "warn", head: "새 위치로는 아직 복사 안 함" });
  const failed = replicaView(base({ result: { ...base().result!, state: "failed", error_code: "target_unavailable" } }), false);
  expect(failed.tone).toBe("bad");
  expect(failed.lines.join(" ")).toContain("마지막 성공");
  expect(replicaView(base({ target: null, target_id: null }), false).head).toBe("복사 위치가 없습니다");
});

it("옛 서버(라우트 없음)면 업데이트 안내만 보인다", async () => {
  mocks.status.mockRejectedValue(new HttpError(404, "404: Not Found", "Not Found"));
  await mount();
  expect(host.textContent).toContain("공유 서버를 업데이트한 뒤 사용할 수 있습니다");
});

it("예약 작업이 없으면 [지금 복사]를 막고 이유를 보인다", async () => {
  mocks.status.mockResolvedValue(base({ task: { ...base().task!, exists: false } }));
  await mount();
  expect(button("지금 복사").disabled).toBe(true);
  expect(host.textContent).toContain("register_autostart.bat");
});

it("[저장]은 비밀번호 확인 창을 거쳐 지금 위치의 지문과 함께 보낸다", async () => {
  mocks.status.mockResolvedValue(base());
  mocks.save.mockResolvedValue(base({ target: "\\\\NAS2\\b", target_id: "ccc" }));
  await mount();
  const input = host.querySelector<HTMLInputElement>('input[aria-label="백업 복사 위치"]')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { setter.call(input, "\\\\NAS2\\b"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => { button("저장").click(); });
  const pw = host.querySelector<HTMLInputElement>('input[type="password"]')!;
  await act(async () => { setter.call(pw, "secret"); pw.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => { button("바꾸기").click(); });
  expect(mocks.save).toHaveBeenCalledWith("\\\\NAS2\\b", "aaa", "secret");
  expect(host.querySelector('input[type="password"]')).toBeNull();
  expect(host.textContent).toContain("바꿨습니다");
});

it("드라이브 글자 주소는 저장 단추가 잠긴다", async () => {
  mocks.status.mockResolvedValue(base());
  await mount();
  const input = host.querySelector<HTMLInputElement>('input[aria-label="백업 복사 위치"]')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { setter.call(input, "D:\\mvhub_backup"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  expect(button("저장").disabled).toBe(true);
});

it("예약 복사가 도는 중에 열면 끝날 때까지 갱신하고 멈춘다", async () => {
  vi.useFakeTimers();
  mocks.status.mockResolvedValueOnce(base({ task: { ...base().task!, running: true } }));
  await mount();
  expect(host.textContent).toContain("복사 중");
  mocks.status.mockResolvedValue(base());
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(host.textContent).toContain("마지막 복사 성공");
  const calls = mocks.status.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
  expect(mocks.status.mock.calls.length).toBe(calls);
});

it("응답 전에 창을 닫으면 다시 읽기 타이머를 만들지 않는다", async () => {
  vi.useFakeTimers();
  mocks.status.mockResolvedValue(base());
  let release!: (v: { requested_at: string; baseline_last_run_at: string | null }) => void;
  mocks.run.mockReturnValue(new Promise((resolve) => { release = resolve; }));
  await mount();
  await act(async () => { button("지금 복사").click(); });
  const calls = mocks.status.mock.calls.length;
  act(() => root.unmount());
  await act(async () => { release({ requested_at: "2026-10-02T10:00:00Z", baseline_last_run_at: null }); });
  await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
  expect(mocks.status.mock.calls.length).toBe(calls);
  root = createRoot(host); // afterEach 의 unmount 용
});

it("통신이 계속 실패해도 30분 뒤엔 멈추고 알린다", async () => {
  vi.useFakeTimers();
  mocks.status.mockResolvedValueOnce(base());
  mocks.run.mockResolvedValue({ requested_at: "2026-10-02T10:00:00Z", baseline_last_run_at: null });
  await mount();
  await act(async () => { button("지금 복사").click(); });
  mocks.status.mockRejectedValue(new Error("offline"));
  await act(async () => { await vi.advanceTimersByTimeAsync(31 * 60 * 1000); });
  expect(host.textContent).toContain("확인 시간 초과");
  const calls = mocks.status.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
  expect(mocks.status.mock.calls.length).toBe(calls);
});

it("[지금 복사] 뒤 새 실행이 끝나면 다시 읽기를 멈춘다", async () => {
  vi.useFakeTimers();
  mocks.status.mockResolvedValueOnce(base());
  mocks.run.mockResolvedValue({ requested_at: "2026-10-02T10:00:00Z", baseline_last_run_at: "2026-10-02T03:30:00Z" });
  await mount();
  await act(async () => { button("지금 복사").click(); });
  expect(host.textContent).toContain("복사 중");
  mocks.status.mockResolvedValue(base({
    task: { ...base().task!, last_run_at: "2026-10-02T10:00:01Z" },
    result: { ...base().result!, started_at: "2026-10-02T10:00:02Z", last_attempt_at: "2026-10-02T10:01:00Z", copied: 1 },
  }));
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(host.textContent).toContain("마지막 복사 성공");
  const calls = mocks.status.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
  expect(mocks.status.mock.calls.length).toBe(calls);
});
