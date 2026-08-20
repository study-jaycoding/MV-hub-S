import type { Planning } from "../components/manage/types";

export type BudgetPeriod = NonNullable<Planning["budget_period"]>;

export const DEFAULT_BUDGET_PERIOD: BudgetPeriod = "month";
export const BUDGET_PERIOD_OPTIONS: { value: BudgetPeriod; label: string; shortLabel: string }[] = [
  { value: "day", label: "매일", shortLabel: "일" },
  { value: "week", label: "매주", shortLabel: "주" },
  { value: "month", label: "매월", shortLabel: "월" },
];

export function planningBudgetPeriod(planning?: Planning | null): BudgetPeriod {
  const value = planning?.budget_period;
  return value === "day" || value === "week" || value === "month"
    ? value
    : DEFAULT_BUDGET_PERIOD;
}

export function budgetPeriodLabel(
  planning?: Planning | null,
  short = false,
): string {
  const period = planningBudgetPeriod(planning);
  const option = BUDGET_PERIOD_OPTIONS.find((item) => item.value === period);
  return short ? option?.shortLabel || "월" : option?.label || "매월";
}

export type PlanningValidationResult =
  | { planning: Planning; error: "" }
  | { planning: null; error: string };

export function planningBudgetInput(planning: Planning): string {
  return planning.budget_credits == null ? "" : String(planning.budget_credits);
}

export function validateProjectPlanning(
  form: Planning,
  budgetInput: string,
): PlanningValidationResult {
  if (form.start_date && form.due_date && form.due_date < form.start_date) {
    return { planning: null, error: "마감일은 시작일보다 빠를 수 없습니다." };
  }

  const budget = budgetInput.trim() ? Number(budgetInput) : null;
  if (budget != null && (!Number.isFinite(budget) || budget < 0)) {
    return { planning: null, error: "예산은 0 이상의 숫자로 입력하세요." };
  }

  const archiveAfterDays = Number(form.archive_after_days ?? 30);
  if (!Number.isInteger(archiveAfterDays) || archiveAfterDays < 1 || archiveAfterDays > 3650) {
    return { planning: null, error: "과거 기록 전환 기간은 1~3650일 사이의 정수로 입력하세요." };
  }

  return {
    planning: {
      status: form.status || null,
      start_date: form.start_date || null,
      due_date: form.due_date || null,
      budget_credits: budget,
      budget_period: planningBudgetPeriod(form),
      archive_after_days: archiveAfterDays,
      note: form.note?.trim() || null,
    },
    error: "",
  };
}
