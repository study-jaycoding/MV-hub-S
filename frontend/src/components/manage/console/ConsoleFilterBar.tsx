// 콘솔 표용 칩 필터 — 작업 탭 필터 바(WorkFilterBar)와 같은 모양·클래스(칩 · + 필터 · 값 체크 목록).
// WorkFilterBar 는 작업(Task) 필드에 묶여 있어 그대로 못 쓴다. 값 매칭은 칩 안 OR, 칩끼리 AND. 전부 화면 안 필터.
import { useState } from "react";
import { useEscapeClose } from "../../../lib/useEscapeClose";

export interface FilterField { key: string; label: string; options: string[] }
export interface ChipFilters { active: string[]; values: Record<string, string[]> }

export const emptyChipFilters = (): ChipFilters => ({ active: [], values: {} });

/** 행이 필터를 통과하는가 — valueOf(row, key) 가 그 칩에서 고른 값 중 하나면 통과(칩 안 OR, 칩끼리 AND). */
export function passesChipFilters<T>(row: T, filters: ChipFilters, valueOf: (row: T, key: string) => string): boolean {
  return filters.active.every((key) => {
    const picked = filters.values[key] ?? [];
    return !picked.length || picked.includes(valueOf(row, key));
  });
}

export function ConsoleFilterBar({ fields, filters, onChange }: { fields: FilterField[]; filters: ChipFilters; onChange: (next: ChipFilters) => void }) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  useEscapeClose(() => { setOpenKey(null); setAddOpen(false); }, addOpen || openKey !== null, true, true);
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const inactive = fields.filter((f) => !filters.active.includes(f.key) && f.options.length);
  const toggle = (key: string, value: string) => {
    const cur = filters.values[key] ?? [];
    onChange({ ...filters, values: { ...filters.values, [key]: cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value] } });
  };
  return (
    <div className="work-filterbar">
      <div className="work-chips">
        {filters.active.map((key) => {
          const field = byKey.get(key);
          if (!field) return null;
          const sel = filters.values[key] ?? [];
          return (
            <div key={key} className="work-chip-wrap">
              <button type="button" className={"work-chip" + (sel.length ? " on" : "")} onClick={() => setOpenKey((c) => (c === key ? null : key))}>
                <span className="work-chip-label">{field.label}</span>
                {sel.length > 0 && <span className="work-chip-count">{sel.length}</span>}
                <span className="work-chip-caret">▾</span>
              </button>
              <button type="button" className="work-chip-x" title="필터 제거"
                onClick={() => { onChange({ active: filters.active.filter((k) => k !== key), values: { ...filters.values, [key]: [] } }); setOpenKey(null); }}>✕</button>
              {openKey === key && (
                <>
                  <div className="work-pop-backdrop" onClick={() => setOpenKey(null)} />
                  <div className="work-pop">
                    <div className="work-pop-list">
                      {field.options.map((opt) => (
                        <div key={opt} className="work-pop-optrow">
                          <label className="work-pop-opt">
                            <input type="checkbox" checked={sel.includes(opt)} onChange={() => toggle(key, opt)} />
                            <span className="work-pop-opt-txt">{opt}</span>
                          </label>
                        </div>
                      ))}
                    </div>
                    {sel.length > 0 && (
                      <button type="button" className="work-pop-clear" onClick={() => onChange({ ...filters, values: { ...filters.values, [key]: [] } })}>
                        선택 해제 ({sel.length})
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
      {inactive.length > 0 && (
        <div className="work-chip-wrap work-add-wrap">
          <button type="button" className="work-chip work-chip-add" onClick={() => setAddOpen((o) => !o)}>+ 필터</button>
          {addOpen && (
            <>
              <div className="work-pop-backdrop" onClick={() => setAddOpen(false)} />
              <div className="work-pop work-pop-add work-pop-right">
                <div className="work-pop-head">필터 기준</div>
                {inactive.map((f) => (
                  <button key={f.key} type="button" className="work-pop-item"
                    onClick={() => { onChange({ ...filters, active: [...filters.active, f.key] }); setAddOpen(false); setOpenKey(f.key); }}>
                    {f.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
