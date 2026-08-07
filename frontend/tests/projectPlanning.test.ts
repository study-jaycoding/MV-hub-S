import { describe, expect, it } from "vitest";
import {
  budgetPeriodLabel,
  planningBudgetInput,
  planningBudgetPeriod,
  validateProjectPlanning,
} from "../src/lib/projectPlanning";

describe("project planning", () => {
  it("normalizes valid schedule and budget values", () => {
    expect(validateProjectPlanning({
      status: "active",
      start_date: "2026-08-07",
      due_date: "2026-08-31",
      budget_period: "week",
      note: "  1차 일정  ",
    }, "1200")).toEqual({
      planning: {
        status: "active",
        start_date: "2026-08-07",
        due_date: "2026-08-31",
        budget_credits: 1200,
        budget_period: "week",
        note: "1차 일정",
      },
      error: "",
    });
  });

  it("rejects a due date before the start date", () => {
    expect(validateProjectPlanning({
      start_date: "2026-08-31",
      due_date: "2026-08-07",
    }, "")).toEqual({
      planning: null,
      error: "마감일은 시작일보다 빠를 수 없습니다.",
    });
  });

  it("rejects negative or non-numeric budgets", () => {
    expect(validateProjectPlanning({}, "-1").planning).toBeNull();
    expect(validateProjectPlanning({}, "not-a-number").planning).toBeNull();
  });

  it("formats an existing budget for the settings form", () => {
    expect(planningBudgetInput({ budget_credits: 42 })).toBe("42");
    expect(planningBudgetInput({ budget_credits: null })).toBe("");
  });

  it("uses monthly budget as the compatible default and labels every period", () => {
    expect(planningBudgetPeriod({})).toBe("month");
    expect(budgetPeriodLabel({ budget_period: "day" })).toBe("매일");
    expect(budgetPeriodLabel({ budget_period: "week" }, true)).toBe("주");
    expect(budgetPeriodLabel({ budget_period: "month" })).toBe("매월");
  });
});
