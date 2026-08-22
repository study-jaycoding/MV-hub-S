import { describe, expect, it } from "vitest";
import { isStableConnection, progressReconnectDelayMs } from "./progressSocket";

// R13-WS-1 — 유지보수 거부(1013)는 서버가 accept 한 뒤 곧바로 닫아 매번 onopen 이 뜬다.
// 열렸다는 사실만으로 백오프를 되돌리면 유지보수 내내 1초 간격 재접속이 된다.
describe("progress socket 재연결 백오프", () => {
  it("accept 직후 닫힌 거부 연결은 '안정'으로 치지 않는다", () => {
    expect(isStableConnection(0)).toBe(false);
    expect(isStableConnection(30)).toBe(false); // 1013 거부 = 수십 ms
    expect(isStableConnection(4999)).toBe(false);
  });

  it("연결 자체가 열리지 못한 경우(onopen 없음)도 리셋 대상이 아니다", () => {
    expect(isStableConnection(null)).toBe(false);
  });

  it("일정 시간 유지된 뒤 끊긴 연결만 백오프를 처음으로 되돌린다", () => {
    expect(isStableConnection(5000)).toBe(true);
    expect(isStableConnection(120000)).toBe(true);
  });

  it("거부가 반복되면 재시도 간격이 실제로 늘어난다(1초 고정 방지)", () => {
    // onclose 가 하는 계산과 같은 순서: 안정 아님 → 리셋 없음 → 지연 산출 → 백오프 증가.
    let backoff = 1000;
    const delays: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      if (isStableConnection(20)) backoff = 1000;
      delays.push(progressReconnectDelayMs(backoff, () => 0.5));
      backoff = Math.min(backoff * 1.6, 15000);
    }

    expect(delays).toEqual([1000, 1600, 2560, 4096, 6554]);
  });

  it("잘 붙어 있던 연결이 끊기면 종전처럼 곧바로(1초) 재시도한다", () => {
    let backoff = 6554;
    if (isStableConnection(60000)) backoff = 1000;

    expect(progressReconnectDelayMs(backoff, () => 0.5)).toBe(1000);
  });
});
