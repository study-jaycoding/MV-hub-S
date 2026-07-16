// seedancePrompt 토큰 문법 특성화 — 생성 실패와 직결되는 순수 파싱 로직 고정.
import { describe, it, expect } from "vitest";
import {
  usesMediaRefTokens,
  hasMediaRefTokens,
  seedanceAtTokenKind,
  seedanceCanonToken,
  seedanceTokenRoles,
  normalizeMediaRefTokensBasic,
} from "../src/lib/seedancePrompt";

describe("usesMediaRefTokens", () => {
  it("비어있지 않은 모델이면 토큰 사용", () => {
    expect(usesMediaRefTokens("nano_banana")).toBe(true);
    expect(usesMediaRefTokens("seedance_2_0")).toBe(true);
  });
  it("빈 모델이면 false", () => {
    expect(usesMediaRefTokens("")).toBe(false);
  });
});

describe("hasMediaRefTokens", () => {
  it("<<<imageN>>> / @imageN 를 감지", () => {
    expect(hasMediaRefTokens("배경에 <<<image1>>> 합성")).toBe(true);
    expect(hasMediaRefTokens("@image2 스타일로")).toBe(true);
  });
  it("토큰 없으면 false", () => {
    expect(hasMediaRefTokens("그냥 텍스트")).toBe(false);
  });
  it("경계: 앞에 영문/숫자가 붙은 @는 토큰 아님(이메일 등 오인 방지)", () => {
    expect(hasMediaRefTokens("foo@image1")).toBe(false);
    expect(hasMediaRefTokens("@image1x")).toBe(false); // 뒤에 문자 붙으면 거절
  });
});

describe("seedanceAtTokenKind", () => {
  it("원종류 → 분류", () => {
    expect(seedanceAtTokenKind("simage")).toBe("start");
    expect(seedanceAtTokenKind("eimage")).toBe("end");
    expect(seedanceAtTokenKind("image")).toBe("image");
    expect(seedanceAtTokenKind("video")).toBe("video");
    expect(seedanceAtTokenKind("vedio")).toBe("video"); // 오타 보정
    expect(seedanceAtTokenKind("audio")).toBe("audio");
  });
});

describe("seedanceCanonToken", () => {
  it("vedio 오타를 video 로 통일", () => {
    expect(seedanceCanonToken("vedio", 2)).toBe("@video2");
    expect(seedanceCanonToken("image", 1)).toBe("@image1");
  });
});

describe("seedanceTokenRoles", () => {
  it("타입 그룹별 순번으로 역할 집계", () => {
    const roles = seedanceTokenRoles("@image1 <<<video2>>> @audio1 @simage1");
    expect([...(roles.image.get(1) ?? [])].sort()).toEqual(["image", "start"]);
    expect([...roles.video]).toEqual([2]);
    expect([...roles.audio]).toEqual([1]);
  });
  it("번호 0/음수는 무시", () => {
    const roles = seedanceTokenRoles("<<<image0>>>");
    expect(roles.image.size).toBe(0);
  });
});

describe("normalizeMediaRefTokensBasic", () => {
  it("알약(@imageN)·언더바·vedio 오타를 CLI 용 <<<kindN>>> 로 통일(바이트 왕복 안전)", () => {
    expect(normalizeMediaRefTokensBasic("@image1 과 @vedio2")).toBe("<<<image1>>> 과 <<<video2>>>");
    expect(normalizeMediaRefTokensBasic("<<<simage1>>>")).toBe("<<<image1>>>"); // 시작프레임도 image 그룹
  });
});
