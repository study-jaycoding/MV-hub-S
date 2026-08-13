import { afterEach, describe, expect, it, vi } from "vitest";
import { connectProgress } from "../src/lib/progressSocket";

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  readyState = FakeWebSocket.OPEN;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(): void {}
  close(): void {}
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  FakeWebSocket.instances = [];
});

describe("connectProgress", () => {
  it("최초 연결에는 중복 reload를 부르지 않고 실제 재연결에만 보정 콜백을 실행한다", () => {
    vi.useFakeTimers();
    vi.stubGlobal("location", { protocol: "http:", host: "127.0.0.1:5173" });
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const onReconnect = vi.fn();
    const off = connectProgress(() => {}, onReconnect);

    expect(FakeWebSocket.instances).toHaveLength(1);
    FakeWebSocket.instances[0].onopen?.();
    expect(onReconnect).not.toHaveBeenCalled();

    FakeWebSocket.instances[0].onclose?.({ code: 1006 });
    vi.advanceTimersByTime(1600);
    expect(FakeWebSocket.instances).toHaveLength(2);
    FakeWebSocket.instances[1].onopen?.();
    expect(onReconnect).toHaveBeenCalledTimes(1);

    off();
  });

  it("최초 연결 시도부터 실패했다면 첫 성공 시 초기 조회 실패를 보정한다", () => {
    vi.useFakeTimers();
    vi.stubGlobal("location", { protocol: "http:", host: "127.0.0.1:5173" });
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const onReconnect = vi.fn();
    const off = connectProgress(() => {}, onReconnect);

    FakeWebSocket.instances[0].onclose?.({ code: 1006 });
    vi.advanceTimersByTime(1600);
    FakeWebSocket.instances[1].onopen?.();
    expect(onReconnect).toHaveBeenCalledTimes(1);

    off();
  });

  it("인증 정책 종료 1008은 재시도해도 해결되지 않으므로 다시 연결하지 않는다", () => {
    vi.useFakeTimers();
    vi.stubGlobal("location", { protocol: "http:", host: "192.168.1.199:8010" });
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const off = connectProgress(() => {});

    FakeWebSocket.instances[0].onclose?.({ code: 1008 });
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);

    off();
  });
});
