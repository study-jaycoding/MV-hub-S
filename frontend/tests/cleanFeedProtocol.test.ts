// 클린 피드 전용 창의 순수 규칙(lib/cleanFeedProtocol) — 시계·재동기·키·허브 글. 계약 docs/status/편집탭_클린피드_전용창_구현_2026-10-23.md '구현에서 정한 것' 4·5.
import { describe, expect, it } from "vitest";
import {
  asSample, feedClock, feedKeyRoute, FEED_CLIENT, HOLD_MS, isStandbyToken, newerSample, nextOpenSeq, parseHubMessage, synced,
  type FeedSample, type FeedSyncState,
} from "../src/lib/cleanFeedProtocol";

const sample = (over: Partial<FeedSample> = {}): FeedSample => ({
  rev: 1, t: 2, at: 1000, playing: true, moving: true, rate: 1, limit: 10, sync: 0, ...over,
});
const state = (best: FeedSample | null, over: Partial<FeedSyncState> = {}): FeedSyncState => ({ visibleSync: 0, hidden: false, best, ...over });

describe("feedClock — 추종기에 주는 시각·재생", () => {
  it("재생 표본은 at 기준으로 외삽한다 — 앱 표본이 잠깐 끊겨도(앱 주 스레드가 바쁨) 이어 가고, limit·0 을 넘지 않는다", () => {
    expect(feedClock(state(sample()), 1020, 1, 0)).toEqual({ time: 2.02, playing: true, rate: 1 });
    expect(feedClock(state(sample()), 1150, 1, 0)).toEqual({ time: 2.15, playing: true, rate: 1 }); // 0.15초 끊김 — 멈추지도 되감지도 않는다
    expect(feedClock(state(sample({ t: 9.98 })), 1090, 1, 0).time).toBe(10); // 반복 끝·타임라인 끝
    expect(feedClock(state(sample({ t: 0.01, rate: -2 })), 1090, 1, 0)).toEqual({ time: 0, playing: true, rate: -2 }); // 역재생은 0 에서 멈춤
    expect(feedClock(state(sample({ rate: 2 })), 1010, 1, 0).time).toBeCloseTo(2.02); // 배속
  });

  it("멈춤·움직임 없음(버퍼링·이동 직후)은 그 시각에 즉시 멈추고, HOLD_MS 넘게 끊기면 외삽한 그 자리에 선다(되감지 않는다)", () => {
    expect(feedClock(state(sample({ playing: false })), 1050, 1, 0)).toEqual({ time: 2, playing: false, rate: 1 });
    expect(feedClock(state(sample({ moving: false })), 1050, 1, 0)).toEqual({ time: 2, playing: false, rate: 1 }); // moving=false 도
    expect(feedClock(state(sample()), 1000 + HOLD_MS, 1, 0)).toEqual({ time: 2 + HOLD_MS / 1000, playing: true, rate: 1 });
    expect(feedClock(state(sample()), 1000 + HOLD_MS + 300, 1, 0)).toEqual({ time: 2 + HOLD_MS / 1000, playing: false, rate: 1 });
  });

  it("장면과 rev 가 다르면 — 새 rev(장면이 아직 안 옴)는 그 전 시각을 들고, 옛 rev 는 그 시각에 멈춘다", () => {
    expect(feedClock(state(sample({ rev: 3, t: 7 })), 1010, 2, 4.5)).toEqual({ time: 4.5, playing: false, rate: 1 });
    expect(feedClock(state(sample({ rev: 1, t: 7 })), 1010, 2, 4.5)).toEqual({ time: 7, playing: false, rate: 1 });
    expect(feedClock(state(null), 1010, 2, 4.5)).toEqual({ time: 4.5, playing: false, rate: 1 });
  });

  it("숨김 → 보임: 숨은 동안은 재생하지 않고, visible{n} 뒤 sync ≥ n 인 표본이 와야 재생 — 순서가 뒤집혀도 맞다", () => {
    let s = state(sample(), { hidden: true });
    expect(feedClock(s, 1010, 1, 0).playing).toBe(false); // 숨김 중 받은 표본은 재생을 시작하지 않는다
    s = { ...s, hidden: false, visibleSync: 1 }; // visible{sync:1} — 그 전 번호의 표본뿐
    expect(synced(s)).toBe(false);
    expect(feedClock(s, 1010, 1, 0)).toEqual({ time: 2, playing: false, rate: 1 }); // 마지막 그림(멈춘 시각)
    s = { ...s, best: sample({ sync: 1, t: 5, at: 1100 }) }; // resync 응답 표본
    expect(feedClock(s, 1110, 1, 0)).toEqual({ time: 5.01, playing: true, rate: 1 });
    // 뒤집힘 — resync 응답 표본(sync 1)이 visible 보다 먼저 왔다
    let r = state(sample({ sync: 1, t: 5, at: 1100 }), { hidden: true });
    expect(synced(r)).toBe(false);
    r = { ...r, hidden: false, visibleSync: 1 };
    expect(synced(r) && feedClock(r, 1110, 1, 0).playing).toBe(true);
  });
});

describe("newerSample — (sync, rev, at) 이 큰 것만", () => {
  it("낮은 번호·옛 rev·옛 at 의 늦은 표본은 최신을 덮지 않는다", () => {
    const best = sample({ sync: 2, rev: 4, at: 500 });
    expect(newerSample(null, best)).toBe(true);
    expect(newerSample(best, sample({ sync: 1, rev: 9, at: 900 }))).toBe(false); // 같은 rev 의 낮은 sync 가 늦게 와도
    expect(newerSample(best, sample({ sync: 2, rev: 3, at: 900 }))).toBe(false);
    expect(newerSample(best, sample({ sync: 2, rev: 4, at: 400 }))).toBe(false);
    expect(newerSample(best, sample({ sync: 2, rev: 4, at: 501 }))).toBe(true);
    expect(newerSample(best, sample({ sync: 3, rev: 1, at: 1 }))).toBe(true);
  });
});

describe("feedKeyRoute — 피드 창의 키", () => {
  const key = (k: string, code: string, alt = false, meta = false) => ({ key: k, code, altKey: alt, metaKey: meta });
  it("편집 키(Alt 조합 포함)는 넘김 · Esc·F11 은 막기만 · Alt+F4·Alt+Tab·Win 은 OS 몫", () => {
    expect(feedKeyRoute(key(" ", "Space"))).toBe("forward");
    expect(feedKeyRoute(key("j", "KeyJ", true))).toBe("forward");
    expect(feedKeyRoute(key("ArrowLeft", "ArrowLeft"))).toBe("forward");
    expect(feedKeyRoute(key("Escape", "Escape"))).toBe("block");
    expect(feedKeyRoute(key("F11", "F11"))).toBe("block");
    expect(feedKeyRoute(key("F4", "F4", true))).toBe("os");
    expect(feedKeyRoute(key("Tab", "Tab", true))).toBe("os");
    expect(feedKeyRoute(key("Meta", "MetaLeft"))).toBe("os");
    expect(feedKeyRoute(key("d", "KeyD", false, true))).toBe("os");
    expect(feedKeyRoute(key("F4", "F4"))).toBe("forward"); // Alt 없는 F4 는 편집 키일 수 있다
  });
});

describe("허브 글", () => {
  it("parseHubMessage 는 종류(t)가 있는 JSON 객체만", () => {
    expect(parseHubMessage('{"t":"resync","sync":2}')).toEqual({ t: "resync", sync: 2 });
    for (const bad of ["not json", "[1]", '{"sync":1}', '{"t":5}', 5, null, "x".repeat(600_001)]) expect(parseHubMessage(bad)).toBeNull();
  });

  it("asSample 은 시각을 'time' 에서 읽고(글의 't' 는 종류) 숫자가 아니면 버린다", () => {
    expect(asSample({ t: "clock", rev: 2, time: 1.5, at: 10, playing: true, moving: true, rate: 1, limit: 9, sync: 1 }))
      .toEqual({ rev: 2, t: 1.5, at: 10, playing: true, moving: true, rate: 1, limit: 9, sync: 1 });
    expect(asSample({ t: "clock", rev: 2, time: 1.5, at: 10, rate: 1, limit: 9 })).toMatchObject({ sync: 0, playing: false, moving: false });
    expect(asSample({ t: 1.5, rev: 2, at: 10, rate: 1, limit: 9 })).toBeNull(); // 시각이 't' 에만 있으면 아니다
    expect(asSample({ t: "clock", rev: 1.5, time: 1, at: 10, rate: 1, limit: 9 })).toBeNull();
    expect(asSample({ t: "clock", rev: 1, time: Number.NaN, at: 10, rate: 1, limit: 9 })).toBeNull();
    expect(asSample({ t: "clock", rev: 1, time: 1, at: 10, rate: 1, limit: 9, sync: "2" })).toBeNull();
  });

  it("탭 id 는 허브의 꼴(8~64자 영숫자)이고 순번은 늘기만 한다", () => {
    expect(FEED_CLIENT).toMatch(/^[0-9A-Za-z_-]{8,64}$/);
    const first = nextOpenSeq();
    expect(nextOpenSeq()).toBe(first + 1);
  });
});

it("대기 토큰은 소문자 16진 글자만 — 하위 프로토콜 헤더에 그대로 싣는다", () => {
  expect(isStandbyToken("ab".repeat(24))).toBe(true);
  for (const bad of [undefined, 1, "", "AB".repeat(24), "../x", "ab cd", "a".repeat(129)]) expect(isStandbyToken(bad)).toBe(false);
});