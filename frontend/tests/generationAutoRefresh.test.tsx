// @vitest-environment jsdom
// 목록 자동 새로고침(주기 폴링·창 복귀)의 '쉬기'(paused) — 폴더 창을 닫은 직후 새 첫 쪽을 기다리는 동안에는 끼어들지 않는다.
//  끼어들면 받던 첫 쪽이 버려지고 한 번 더 받느라 조작 잠금이 길어진다(2026-10-07 실측). 타이머·리스너는 그대로 두고 진입만 막는다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useGenerationAutoRefresh } from "../src/lib/useGenerationAutoRefresh";
import type { Filters, Generation } from "../src/types";

type Props = { tab?: Filters["tab"]; paused?: boolean; active?: boolean };
let root: Root;
let host: HTMLDivElement;
const reload = vi.fn<(silent?: boolean, light?: boolean) => Promise<void>>();
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
  expect(reload).toHaveBeenLastCalledWith(true, true);
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
  expect(reload).toHaveBeenLastCalledWith(true, true);
  act(() => { window.dispatchEvent(new Event("focus")); }); // 방금 받았다 — 5초 가드
  expect(reload).toHaveBeenCalledTimes(1);
});
