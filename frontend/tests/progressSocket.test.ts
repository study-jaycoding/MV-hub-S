import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_EVENTS } from "../src/lib/appEvents";
import { setAuthToken } from "../src/lib/http";
import { connectProgress, progressReconnectDelayMs } from "../src/lib/progressSocket";

// 1008 분기에서 토큰을 지우는지/지키는지를 관찰하기 위해 http 모듈만 목으로 대체한다.
vi.mock("../src/lib/http", () => ({ setAuthToken: vi.fn() }));

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
  vi.clearAllMocks();
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
    expect(setAuthToken).toHaveBeenCalledWith(null);

    off();
    window.removeEventListener(APP_EVENTS.authRequired, authRequired);
    window.removeEventListener(APP_EVENTS.flash, flash);
  });

  it("구서버의 reason 없는 1008은 기존 인증 실패 처리로 폴백한다(하위호환)", () => {
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
    window.addEventListener(APP_EVENTS.authRequired, authRequired);
    const off = connectProgress(() => {});

    FakeWebSocket.instances[0].onclose?.({ code: 1008, reason: "" });
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(authRequired).toHaveBeenCalledTimes(1);
    expect(setAuthToken).toHaveBeenCalledWith(null);

    off();
    window.removeEventListener(APP_EVENTS.authRequired, authRequired);
  });

  it("AUTH-off 로컬 전용 거부(1008)는 토큰을 지키고 로그인 화면 대신 정책 안내만 띄운다", () => {
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

    FakeWebSocket.instances[0].onclose?.({ code: 1008, reason: "auth-off-local-only" });
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1); // 재연결도 멈춘다(재시도해도 같은 거부)
    expect(authRequired).not.toHaveBeenCalled();
    expect(setAuthToken).not.toHaveBeenCalled();
    expect(flash).toHaveBeenCalledTimes(1);
    expect((flash.mock.calls[0][0] as CustomEvent<string>).detail).toContain("로컬에서만");

    off();
    window.removeEventListener(APP_EVENTS.authRequired, authRequired);
    window.removeEventListener(APP_EVENTS.flash, flash);
  });

  it("서버의 계정 범위 flash 메시지를 기존 사용자 토스트 이벤트로 전달한다", () => {
    vi.useFakeTimers();
    vi.stubGlobal("location", { protocol: "http:", host: "127.0.0.1:5173" });
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
    const flash = vi.fn();
    const onMessage = vi.fn();
    window.addEventListener(APP_EVENTS.flash, flash);
    const off = connectProgress(onMessage);

    FakeWebSocket.instances[0].onmessage?.({
      data: JSON.stringify({
        type: "flash",
        message: "에이전트 업데이트가 필요합니다.",
      }),
    });

    expect(flash).toHaveBeenCalledTimes(1);
    expect((flash.mock.calls[0][0] as CustomEvent<string>).detail).toBe(
      "에이전트 업데이트가 필요합니다.",
    );
    expect(onMessage).toHaveBeenCalledWith({
      type: "flash",
      message: "에이전트 업데이트가 필요합니다.",
    });

    off();
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
