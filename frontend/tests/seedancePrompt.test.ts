// seedancePrompt 토큰 문법 특성화 — 생성 실패와 직결되는 순수 파싱 로직 고정.
import { describe, it, expect } from "vitest";
import {
  usesMediaRefTokens,
  seedanceAtTokenKind,
  seedanceCanonToken,
  seedanceTokenRoles,
  seedanceHasTokenRoles,
  normalizeSeedancePromptTokens,
  normalizeMediaRefTokensBasic,
  effectiveSeedanceMode,
  validateSeedanceMode,
  validateSeedanceTokenRoles,
} from "../src/lib/seedancePrompt";

describe("Seedance 2.5 실효 모드", () => {
  for (const mode of ["t2v", "omni_reference", "video_edit", "video_extension"]) {
    it.each([0, 1, 4])(`${mode}: 레퍼런스 %i개`, (count) => {
      const expected = mode === "t2v" || mode === "omni_reference"
        ? count > 0 ? "omni_reference" : "t2v"
        : mode;
      expect(effectiveSeedanceMode("seedance_2_5", mode, count)).toBe(expected);
    });
  }

  it.each(["seedance_2_0", "seedance_2_0_mini", "another_model"])("%s의 모드는 변경하지 않는다", (model) => {
    for (const mode of ["std", "fast", "t2v", "omni_reference", "video_edit", "video_extension"]) {
      for (const count of [0, 1, 4]) expect(effectiveSeedanceMode(model, mode, count)).toBe(mode);
    }
  });

  it("미정·알 수 없는 모드를 임의로 채우지 않는다", () => {
    for (const mode of [undefined, null, "", "unknown"]) {
      expect(effectiveSeedanceMode("seedance_2_5", mode, 1)).toBe(mode);
    }
  });
});

describe("Seedance 2.5 모드 검증", () => {
  const roles = seedanceTokenRoles("");
  const videoRefs = (count: number) => [
    { type: "image" }, { type: "audio" },
    ...Array.from({ length: count }, () => ({ type: "video" })),
  ];

  it.each([0, 1, 3])("영상 고치기: 영상 %i개 (이미지·오디오는 개수에 포함 안 함)", (count) => {
    const expected = count === 0
      ? "고칠 영상을 1개 넣어 주세요 — 영상 고치기 모드는 영상 레퍼런스가 정확히 1개 필요합니다."
      : count === 1 ? null : "영상은 1개만 넣을 수 있습니다 — 지금 3개입니다.";
    expect(validateSeedanceMode("seedance_2_5", "video_edit", videoRefs(count), roles, undefined)).toBe(expected);
  });

  it.each([0, 1, 3])("이어붙이기: 영상 %i개 (여러 영상도 허용)", (count) => {
    expect(validateSeedanceMode("seedance_2_5", "video_extension", videoRefs(count), roles, "forward"))
      .toBe(count === 0 ? "이어붙일 영상을 넣어 주세요." : null);
  });

  for (const mode of ["video_edit", "video_extension"]) {
    it.each(["@simage1", "@eimage1", "<<<simage1>>>", "<<<eimage1>>>"])(`${mode}에서 %s 금지`, (token) => {
      const tokenRoles = seedanceTokenRoles(token);
      // 토큰↔이미지 정합 자체는 유효하다. 기존 검증의 계약은 바꾸지 않는다.
      expect(validateSeedanceTokenRoles(videoRefs(1), tokenRoles)).toBeNull();
      expect(validateSeedanceMode("seedance_2_5", mode, videoRefs(1), tokenRoles, "forward"))
        .toBe(`첫/끝 프레임은 레퍼런스 모드에서만 쓸 수 있습니다 — 지금 모드는 ${mode === "video_edit" ? "영상 고치기" : "영상 이어붙이기"}입니다.`);
    });
  }

  it("omni에서는 첫/끝 프레임 허용", () => {
    expect(validateSeedanceMode("seedance_2_5", "omni_reference", [{ type: "image" }, { type: "image" }],
      seedanceTokenRoles("@simage1 @eimage2"), undefined)).toBeNull();
  });

  it.each([undefined, null, "", "  "])("이어붙이기 방향 %s 누락은 오류", (direction) => {
    expect(validateSeedanceMode("seedance_2_5", "video_extension", videoRefs(1), roles, direction))
      .toBe("이어붙일 방향(extension_mode)을 선택해 주세요.");
  });

  it.each(["seedance_2_0", "seedance_2_0_mini"])("%s에는 2.5의 모드 규칙을 적용하지 않는다", (model) => {
    expect(validateSeedanceMode(model, "video_edit", [], seedanceTokenRoles("@simage1"), undefined)).toBeNull();
    expect(validateSeedanceMode(model, "video_extension", [], roles, undefined)).toBeNull();
  });
});

describe("미디어 참조 토큰 경계 — 이메일·접미 글자 오인 방지 (SEEDANCE_TOKEN_SRC)", () => {
  // 앞이 영문/숫자/밑줄이거나(foo@image1, 1@image1, _@image1, user@video2) 뒤에 영문/밑줄이 붙으면
  // (@image1x, @image_1_, @audio1_ok) 토큰이 아니다(뒤의 숫자는 번호의 일부: @image12 = 12번). 앞 경계 클래스의
  // 글자·숫자·밑줄 각각을 고정한다.
  const notTokens = "foo@image1 1@image1 _@image1 @image1x @image_1_ user@video2 @audio1_ok";

  it("정규화가 원문을 그대로 둔다(프롬프트를 바꾸지 않음) — 기본·seedance 제출 경로 모두", () => {
    expect(normalizeMediaRefTokensBasic(notTokens)).toBe(notTokens);
    expect(normalizeSeedancePromptTokens(notTokens)).toBe(notTokens);
  });

  it("역할 집계도 0개다(잘못된 참조 역할을 주지 않음)", () => {
    expect(seedanceHasTokenRoles(seedanceTokenRoles(notTokens))).toBe(false);
  });

  it("공백·문장부호·괄호·줄 끝은 경계라서 그 옆의 토큰은 인식한다", () => {
    expect(normalizeMediaRefTokensBasic("배경에 @image1, 끝")).toBe("배경에 <<<image1>>>, 끝");
    expect(normalizeMediaRefTokensBasic("(@video2)")).toBe("(<<<video2>>>)");
    expect(normalizeMediaRefTokensBasic("@image1")).toBe("<<<image1>>>");
    // 한글은 경계 문자(영문·숫자·밑줄)가 아니라서 붙여 써도 토큰이다 — 한국어 프롬프트의 현행 동작 고정.
    expect(normalizeMediaRefTokensBasic("배경은@image1로")).toBe("배경은<<<image1>>>로");
    const roles = seedanceTokenRoles("@image1,@image2.");
    expect([...roles.image.keys()].sort()).toEqual([1, 2]);
  });
});

describe("usesMediaRefTokens", () => {
  it("비어있지 않은 모델이면 토큰 사용", () => {
    expect(usesMediaRefTokens("nano_banana")).toBe(true);
    expect(usesMediaRefTokens("seedance_2_0")).toBe(true);
  });
  it("빈 모델이면 false", () => {
    expect(usesMediaRefTokens("")).toBe(false);
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
