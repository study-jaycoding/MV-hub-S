import { useState } from "react";
import {
  BUDGET_PERIOD_OPTIONS,
  planningBudgetInput,
  planningBudgetPeriod,
  validateProjectPlanning,
} from "../../lib/projectPlanning";
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

export function ProjectPlanningDialog({
  projectName,
  initialValue,
  onClose,
  onSave,
}: {
  projectName: string;
  initialValue: Planning;
  onClose: () => void;
  onSave: (value: Planning) => Promise<void>;
}) {
  const [form, setForm] = useState<Planning>(() => ({ status: "active", ...initialValue }));
  const [budgetInput, setBudgetInput] = useState(() => planningBudgetInput(initialValue));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const save = async () => {
    if (saving) return;
    const result = validateProjectPlanning(form, budgetInput);
    if (!result.planning) {
      setError(result.error);
      return;
    }
    setSaving(true);
    setError("");
    try {
      await onSave(result.planning);
    } catch (reason) {
      setError(`저장 실패: ${String((reason as Error)?.message || reason)}`);
      setSaving(false);
    }
  };

  return (
    <div className="manage-modal-back" onMouseDown={onClose}>
      <div className="manage-modal manage-planning-modal" onMouseDown={(event) => event.stopPropagation()}>
        <h3>{projectName} — 일정·예산</h3>
        <ProjectPlanningFields
          form={form}
          budgetInput={budgetInput}
          onFormChange={(value) => { setForm(value); setError(""); }}
          onBudgetInputChange={(value) => { setBudgetInput(value); setError(""); }}
        />
        {error && <div className="login-error">{error}</div>}
        <div className="manage-modal-actions">
          <button type="button" onClick={onClose} disabled={saving}>취소</button>
          <button type="button" className="manage-primary" onClick={save} disabled={saving}>
            {saving ? "저장 중…" : "저장"}
          </button>
        </div>
      </div>
    </div>
  );
}
