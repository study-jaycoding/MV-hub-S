import { BUDGET_PERIOD_OPTIONS, planningBudgetPeriod } from "../../lib/projectPlanning";
import { acceptThousands, formatThousands } from "../../lib/creditPlan";
import type { Planning } from "./types";
import { ProjectDateRangePicker } from "./ProjectDateRangePicker";

export const PROJECT_STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "active", label: "활성" },
  { value: "hold", label: "비활성" },
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
        <span>작업 자동 보관(일)</span>
        <div className="manage-budget-limit">
          <input
            type="number"
            min={1}
            max={3650}
            // 비운 채로 둘 수 있다(비우면 기본 30일 — 자리 글자가 알려 준다). 전엔 `Number(값) || 30` 이라 지우거나 0 을 치는 순간 30 으로
            //  바뀌어, 지우고 7 을 치면 307 이 됐다. 범위(1~3650)는 저장할 때 본다(lib/projectPlanning — 0 은 거절한다).
            value={form.archive_after_days ?? ""}
            placeholder="30"
            aria-label="자동 작업 보관 기준 일수"
            onChange={(event) => update("archive_after_days", event.target.value === "" ? null : Number(event.target.value))}
          />
          <em>일 동안 새 생성 없음</em>
        </div>
      </label>
      <label className="manage-field">
        <span>예산 한도</span>
        <div className="manage-budget-limit">
          <input
            type="text"
            inputMode="numeric"
            value={formatThousands(budgetInput)}
            placeholder="제한 없음"
            aria-label="예산 크레딧"
            onChange={(event) => { const next = acceptThousands(event.target.value); if (next !== null) onBudgetInputChange(next); }}
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
