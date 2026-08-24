import { describe, expect, it } from "vitest";
import { spotlightEnterAction } from "../src/lib/spotlightPromptKeyboard";

const enter = (overrides: Partial<Parameters<typeof spotlightEnterAction>[0]> = {}) => ({
  key: "Enter",
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  repeat: false,
  shiftKey: false,
  ...overrides,
});

describe("프롬프트 Enter 안전 규칙", () => {
  it("Alt+Enter만 생성을 요청한다", () => {
    expect(spotlightEnterAction(enter({ altKey: true }))).toBe("submit");
  });

  it("일반 Enter와 Shift+Enter는 줄바꿈이다", () => {
    expect(spotlightEnterAction(enter())).toBe("line_break");
    expect(spotlightEnterAction(enter({ shiftKey: true }))).toBe("line_break");
  });

  it("추가 조합키가 섞인 Enter는 생성하지 않는다", () => {
    expect(spotlightEnterAction(enter({ altKey: true, shiftKey: true }))).toBe("line_break");
    expect(spotlightEnterAction(enter({ altKey: true, ctrlKey: true }))).toBe("line_break");
    expect(spotlightEnterAction(enter({ altKey: true, metaKey: true }))).toBe("line_break");
  });

  it("Alt+Enter를 누르고 있어도 반복 생성하지 않는다", () => {
    expect(spotlightEnterAction(enter({ altKey: true, repeat: true }))).toBe("consume");
  });

  it("Enter가 아닌 키에는 관여하지 않는다", () => {
    expect(spotlightEnterAction(enter({ key: "a", altKey: true }))).toBeNull();
  });
});
