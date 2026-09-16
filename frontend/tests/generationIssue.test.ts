import { describe, expect, it } from "vitest";
import { classifyGenerationError } from "../src/lib/generationIssue";
import cases from "./fixtures/generationErrorCases.json";

describe("CLI 오류 원인 — 에이전트와 동일한 공통 사례", () => {
  it.each(cases)("$name", ({ error, code }) => {
    expect(classifyGenerationError(error)).toBe(code);
  });
});
