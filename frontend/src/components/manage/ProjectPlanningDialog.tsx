import { BUDGET_PERIOD_OPTIONS, planningBudgetPeriod } from "../../lib/projectPlanning";
import type { Planning } from "./types";
import { ProjectDateRangePicker } from "./ProjectDateRangePicker";

export const PROJECT_STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "active", label: "진행" },
  { value: "hold", label: "보류" },
  { value: "done", label: "완료" },
];

export function ProjectPlanningFields({
  form,
  budgetInput,
  onFormChange,
  onBudgetInputChange,
}: {
  form: Planning;
  budgetInput: string;
  onFormChange: (value: Planning) => void;
  onBudgetInputChange: (value: string) => void;
}) {
  const update = <K extends keyof Planning>(key: K, value: Planning[K]) => {
    onFormChange({ ...form, [key]: value });
  };

  return (
    <div className="project-planning-fields">
      <label className="manage-field">
        <span>상태</span>
        <select value={form.status || "active"} onChange={(event) => update("status", event.target.value)}>
          {PROJECT_STATUS_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </label>
      <ProjectDateRangePicker
        startDate={form.start_date}
        dueDate={form.due_date}
        onChange={(startDate, dueDate) => onFormChange({
          ...form,
          start_date: startDate || null,
          due_date: dueDate || null,
        })}
      />
      <label className="manage-field">
        <span>과거 기록 전환</span>
        <div className="manage-budget-limit">
          <input
            type="number"
            min={1}
            max={3650}
            value={form.archive_after_days ?? 30}
            aria-label="자동 작업 보관 기준 일수"
            onChange={(event) => update("archive_after_days", Number(event.target.value) || 30)}
          />
          <em>일 동안 새 생성 없음</em>
        </div>
      </label>
      <label className="manage-field">
        <span>예산 한도</span>
        <div className="manage-budget-limit">
          <input
            type="number"
            min={0}
            value={budgetInput}
            placeholder="제한 없음"
            aria-label="예산 크레딧"
            onChange={(event) => onBudgetInputChange(event.target.value)}
          />
          <em>크레딧</em>
          <select
            value={planningBudgetPeriod(form)}
            aria-label="예산 적용 주기"
            onChange={(event) => update(
              "budget_period",
              event.target.value as Planning["budget_period"],
            )}
          >
            {BUDGET_PERIOD_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </div>
      </label>
      <label className="manage-field">
        <span>메모</span>
        <input type="text" value={form.note || ""} onChange={(event) => update("note", event.target.value)} />
      </label>
    </div>
  );
}
