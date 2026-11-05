// @vitest-environment jsdom
// 관리 창 재조회 예약(Codex 리뷰 P2 2026-11-05) — 출처 있는 신호는 예전처럼 마지막 신호 뒤 180ms(디바운스),
// 출처 없는 신호는 마지막 재조회 뒤 10초를 지키되 먼저 잡힌 재조회를 미루지 않는다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useManageRealtime } from "../src/lib/useManageRealtime";
import type { ProgressMessage } from "../src/types";

const socket = vi.hoisted(() => ({ onMessage: (_message: unknown) => {} }));
vi.mock("../src/lib/progressSocket", () => ({
  connectProgress: (onMessage: (message: unknown) => void) => { socket.onMessage = onMessage; return () => {}; },
}));
vi.mock("../src/lib/librarySync", () => ({ consumeOwnDomainSync: () => false }));

let root: Root, host: HTMLDivElement, signal = 0;
function Probe() { signal = useManageRealtime(true); return null; }
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  act(() => root.render(<Probe />)); // 마운트 순간 = 마지막 재조회(lastRefreshAt)
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const send = (origins?: unknown[]) => act(() => { socket.onMessage({ type: "manage_changed", origins } as unknown as ProgressMessage); });
const wait = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

it("출처 있는 신호가 연달아 오면 마지막 신호 뒤 180ms 에 한 번만 다시 읽는다", () => {
  send([{ mutation_id: "m1" }]);
  wait(100);
  send([{ mutation_id: "m2" }]);
  wait(100);
  send([{ mutation_id: "m3" }]);
  wait(100); // 첫 신호 뒤 300ms — 예전 디바운스라면 아직 안 읽는다
  expect(signal).toBe(0);
  wait(79);
  expect(signal).toBe(0);
  wait(1); // 마지막 신호(200ms) 뒤 180ms
  expect(signal).toBe(1);
  wait(1_000);
  expect(signal).toBe(1);
});

it("출처 없는 신호는 마지막 재조회 뒤 10초를 지키고, 먼저 잡힌 재조회를 미루지 않는다", () => {
  send([]); // 마운트(=마지막 재조회) 직후 — 10초 뒤
  wait(9_999);
  expect(signal).toBe(0);
  wait(1);
  expect(signal).toBe(1); // t=10,000

  wait(2_000);
  send(undefined); // t=12,000 — 남은 8초를 기다린다
  wait(1_000);
  send([{ mutation_id: "m1" }]); // t=13,000 출처 있음 — 0.18초 뒤로 당긴다
  wait(180);
  expect(signal).toBe(2); // t=13,180

  wait(820);
  send([{ mutation_id: "m2" }]); // t=14,000 → 14,180 에 잡힘
  wait(50);
  send([]); // t=14,050 출처 없음 — 10초 간격이면 23,180 이지만 먼저 잡힌 14,180 을 미루지 않는다
  wait(130);
  expect(signal).toBe(3); // t=14,180
  wait(8_000);
  expect(signal).toBe(3); // 출처 없는 신호는 14,180 재조회에 담겼다 — 따로 또 읽지 않는다
});

it("출처 있는 신호가 쉬지 않고 와도 먼저 잡힌 출처 없는 재조회 기한을 넘기지 않는다(Codex 2차 리뷰)", () => {
  send([]); // 마운트 직후 — 기한 10,000
  wait(9_900);
  for (let i = 0; i < 10; i += 1) { // 9,900 부터 100ms 마다 출처 있는 신호 — 디바운스만이면 계속 밀린다
    send([{ mutation_id: `m${i}` }]);
    wait(100);
  }
  expect(signal).toBe(1); // 기한(10,000)에 한 번 읽었다
});
