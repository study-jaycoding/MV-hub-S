import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_EVENTS } from "../src/lib/appEvents";
import { connectProgress, progressReconnectDelayMs } from "../src/lib/progressSocket";

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason?: string }) => void) | null = null;
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
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    vi.stubGlobal("location", { protocol: "http:", host: "127.0.0.1:5173" });
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const onReconnect = vi.fn();
    const off = connectProgress(() => {}, onReconnect);

    expect(FakeWebSocket.instances).toHaveLength(1);
    FakeWebSocket.instances[0].onopen?.();
    expect(onReconnect).not.toHaveBeenCalled();

    FakeWebSocket.instances[0].onclose?.({ code: 1006 });
    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    FakeWebSocket.instances[1].onopen?.();
    expect(onReconnect).toHaveBeenCalledTimes(1);

    off();
  });

  it("최초 연결 시도부터 실패했다면 첫 성공 시 초기 조회 실패를 보정한다", () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    vi.stubGlobal("location", { protocol: "http:", host: "127.0.0.1:5173" });
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const onReconnect = vi.fn();
    const off = connectProgress(() => {}, onReconnect);

    FakeWebSocket.instances[0].onclose?.({ code: 1006 });
    vi.advanceTimersByTime(1000);
    FakeWebSocket.instances[1].onopen?.();
    expect(onReconnect).toHaveBeenCalledTimes(1);

    off();
  });

  it("인증 정책 종료 1008은 재연결을 멈추고 로그인 만료를 사용자에게 알린다", () => {
    vi.useFakeTimers();
    vi.stubGlobal("location", { protocol: "http:", host: "192.168.1.199:8010" });
    vi.stubGlobal("WebSocket", FakeWebSocket);
    class TestCustomEvent<T> extends Event {
      detail: T | undefined;
      constructor(type: string, init?: { detail?: T }) {
        super(type);
        this.detail = init?.detail;
      }
    }
    const eventTarget = new EventTarget();
    vi.stubGlobal("window", eventTarget);
    vi.stubGlobal("CustomEvent", TestCustomEvent);
    const authRequired = vi.fn();
    const flash = vi.fn();
    window.addEventListener(APP_EVENTS.authRequired, authRequired);
    window.addEventListener(APP_EVENTS.flash, flash);
    const off = connectProgress(() => {});

    FakeWebSocket.instances[0].onclose?.({ code: 1008, reason: "authentication required" });
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(authRequired).toHaveBeenCalledTimes(1);
    expect(flash).toHaveBeenCalledTimes(1);

    off();
    window.removeEventListener(APP_EVENTS.authRequired, authRequired);
    window.removeEventListener(APP_EVENTS.flash, flash);
  });

  it("100대가 같은 순간 끊겨도 재연결 시각을 jitter로 분산한다", () => {
    const delays = Array.from({ length: 100 }, (_, index) =>
      progressReconnectDelayMs(1000, () => index / 99),
    );

    expect(Math.min(...delays)).toBe(800);
    expect(Math.max(...delays)).toBe(1200);
    expect(new Set(delays).size).toBeGreaterThan(90);
  });
});
