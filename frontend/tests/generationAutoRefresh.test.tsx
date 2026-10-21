// @vitest-environment jsdom
// 목록 자동 새로고침(주기 폴링·창 복귀)의 '쉬기'(paused) — 폴더 창을 닫은 직후 새 첫 쪽을 기다리는 동안에는 끼어들지 않는다.
//  끼어들면 받던 첫 쪽이 버려지고 한 번 더 받느라 조작 잠금이 길어진다(2026-10-07 실측). 타이머·리스너는 그대로 두고 진입만 막는다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useGenerationAutoRefresh } from "../src/lib/useGenerationAutoRefresh";
import { APP_EVENTS } from "../src/lib/appEvents";
import type { Filters, Generation } from "../src/types";

type Props = { tab?: Filters["tab"]; paused?: boolean; active?: boolean };
let root: Root;
let host: HTMLDivElement;
const reload = vi.fn<(silent?: boolean, light?: boolean, intent?: string) => Promise<void>>();
const idle: Generation[] = [];
const running = [{ id: "g", status: "running" }] as unknown as Generation[];
function Harness({ tab = "team", paused, active }: Props) {
  useGenerationAutoRefresh({ generations: active ? running : idle, tab, reload, paused });
  return null;
}
const show = (props: Props = {}) => act(() => root.render(<Harness {...props} />));
const pass = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  reload.mockReset();
  reload.mockResolvedValue();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

it("쉬는 동안에는 주기 폴링이 다시 받지 않고, 풀리면 원래 주기의 다음 틱부터 받는다 — 주기를 처음부터 다시 세지 않는다", async () => {
  show(); // 팀 탭 유휴: 15초
  await pass(15_000);
  expect(reload).toHaveBeenCalledTimes(1);
  expect(reload).toHaveBeenLastCalledWith(true, true, "check"); // 확인이지 실제 변경이 아니다(83회차)
  await pass(10_000); // 25초
  show({ paused: true });
  await pass(5_000); // 30초 — 쉬는 중의 틱
  expect(reload).toHaveBeenCalledTimes(1);
  await pass(12_000); // 42초
  show({ paused: false });
  expect(reload).toHaveBeenCalledTimes(1); // 풀렸다고 따로 한 번 더 받지 않는다
  await pass(3_000); // 45초 — 원래 주기의 틱(풀린 때부터 15초를 다시 세면 57초다)
  expect(reload).toHaveBeenCalledTimes(2);
});

it("폴링이 아직 안 끝났을 때 쉬었다 풀려도 그 위에 겹쳐 부르지 않는다", async () => {
  let finish!: () => void;
  reload.mockImplementationOnce(() => new Promise<void>((done) => { finish = done; }));
  show();
  await pass(15_000); // 첫 폴링 — 아직 진행 중
  show({ paused: true });
  show({ paused: false });
  await pass(15_000); // 30초 — 앞 폴링이 안 끝났다
  expect(reload).toHaveBeenCalledTimes(1);
  await act(async () => { finish(); });
  await pass(15_000);
  expect(reload).toHaveBeenCalledTimes(2);
});

it("활성 잡의 3초 폴링도 같다 — 쉬는 동안 멈추고 풀리면 이어진다", async () => {
  show({ tab: "my", active: true });
  await pass(3_000);
  expect(reload).toHaveBeenCalledTimes(1);
  show({ tab: "my", active: true, paused: true });
  await pass(9_000);
  expect(reload).toHaveBeenCalledTimes(1);
  show({ tab: "my", active: true, paused: false });
  await pass(3_000);
  expect(reload).toHaveBeenCalledTimes(2);
});

it("창 복귀(focus·visibilitychange)도 쉬는 동안에는 받지 않는다 — 그 복귀가 5초 가드의 시계를 건드리지 않아, 풀린 뒤의 복귀는 바로 받는다", async () => {
  show({ tab: "my" }); // 내 작업 탭·활성 잡 없음 — 주기 폴링은 없다
  await pass(6_000);
  show({ tab: "my", paused: true });
  act(() => { window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); });
  expect(reload).not.toHaveBeenCalled();
  show({ tab: "my", paused: false });
  act(() => { document.dispatchEvent(new Event("visibilitychange")); });
  expect(reload).toHaveBeenCalledTimes(1);
  expect(reload).toHaveBeenLastCalledWith(true, true, "check"); // 확인이지 실제 변경이 아니다(83회차)
  act(() => { window.dispatchEvent(new Event("focus")); }); // 방금 받았다 — 5초 가드
  expect(reload).toHaveBeenCalledTimes(1);
});

it("[stage5] 포커스 조회 직후 주기 틱이 같은 목록을 다시 받지 않는다", async () => {
  show();
  await pass(14_000);
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  expect(reload).toHaveBeenCalledTimes(1);
  await pass(1_000); // 15초 틱 — 포커스 조회가 끝난 지 1초다.
  expect(reload).toHaveBeenCalledTimes(1);
  await pass(15_000); // 다음 정상 주기의 안전망은 계속 돈다.
  expect(reload).toHaveBeenCalledTimes(2);
});

it("[stage5] 느린 주기 조회 중 포커스가 와도 진행 중인 조회를 다시 요청하지 않는다", async () => {
  let finish!: () => void;
  reload.mockImplementationOnce(() => new Promise<void>((done) => { finish = done; }));
  show();
  await pass(15_000);
  expect(reload).toHaveBeenCalledTimes(1);
  try {
    await pass(6_000); // 기존 5초 포커스 가드가 끝나도 앞 조회는 아직 진행 중이다.
    act(() => { window.dispatchEvent(new Event("focus")); });
    expect(reload).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => { finish(); });
  }
  await pass(9_000);
  expect(reload).toHaveBeenCalledTimes(2);
});

it("[stage5] 느린 포커스 조회는 주기와 추가 포커스를 막고 완료 뒤 정상 주기를 재개한다", async () => {
  let finish!: () => void;
  reload.mockImplementationOnce(() => new Promise<void>((done) => { finish = done; }));
  show();
  await pass(6_000);
  act(() => { window.dispatchEvent(new Event("focus")); });
  expect(reload).toHaveBeenCalledTimes(1);
  try {
    await pass(24_000); // 15초·30초 틱 모두 진행 중인 포커스 조회를 기다린다.
    act(() => { window.dispatchEvent(new Event("focus")); });
    expect(reload).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => { finish(); });
  }
  await pass(15_000);
  expect(reload).toHaveBeenCalledTimes(2);
});

it("[stage5] compose로 전환한 뒤 끝난 옛 팀 폴링은 새 화면에 변경 알림을 보내지 않는다", async () => {
  let finish!: () => void;
  reload.mockImplementationOnce(() => new Promise<void>((done) => { finish = done; }));
  const changed = vi.fn();
  window.addEventListener(APP_EVENTS.libraryChanged, changed);
  try {
    show();
    await pass(15_000);
    expect(reload).toHaveBeenCalledTimes(1);
    show({ tab: "compose" });
    await act(async () => { finish(); });
    expect(changed).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener(APP_EVENTS.libraryChanged, changed);
  }
});

it("[stage5-review] 반복 포커스가 팀 주기 조회를 미뤄도 완료마다 사이드바 집계 알림을 보낸다", async () => {
  const changed = vi.fn();
  window.addEventListener(APP_EVENTS.libraryChanged, changed);
  try {
    show();
    for (let i = 0; i < 6; i++) {
      await pass(6_000); // 15초·30초 틱은 직전 포커스 조회 때문에 건너뛴다.
      await act(async () => { window.dispatchEvent(new Event("focus")); });
    }
    expect(reload).toHaveBeenCalledTimes(6);
    expect(changed).toHaveBeenCalledTimes(6);
    expect(changed.mock.calls.every(([event]) => (event as CustomEvent).detail?.poll === true)).toBe(true);
  } finally {
    window.removeEventListener(APP_EVENTS.libraryChanged, changed);
  }
});

it("[stage5-review] compose로 전환한 뒤 끝난 옛 팀 포커스 조회는 집계 알림을 보내지 않는다", async () => {
  let finish!: () => void;
  reload.mockImplementationOnce(() => new Promise<void>((done) => { finish = done; }));
  const changed = vi.fn();
  window.addEventListener(APP_EVENTS.libraryChanged, changed);
  try {
    show();
    await pass(6_000);
    act(() => { window.dispatchEvent(new Event("focus")); });
    expect(reload).toHaveBeenCalledTimes(1);
    show({ tab: "compose" });
    await act(async () => { finish(); });
    expect(changed).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener(APP_EVENTS.libraryChanged, changed);
  }
});
