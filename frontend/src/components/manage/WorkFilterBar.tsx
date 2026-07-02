// 작업탭 노션식 필터 바 — 다중선택 칩(프로젝트/에피소드/시퀀스/상태/생성자) + 자유 검색.
// 옵션 값은 현재 작업 목록에서 뽑는다. 전부 클라이언트 필터(백엔드 무관). 값 매칭은 '포함'(OR),
// 서로 다른 칩끼리는 AND.
import { useMemo, useState } from "react";
import {
  SELECTABLE_STATUSES,
  statusLabel,
  WORK_FILTER_FIELDS,
  WORK_FILTER_LABELS,
  type Task,
  type WorkFilterField,
  type WorkFilters,
} from "./types";

interface Opt {
  value: string;
  label: string;
  color?: string;
}

// 필드별 선택 후보 목록 — 상태는 고정(선택가능 상태), 나머지는 작업에서 distinct.
function optionsFor(field: WorkFilterField, tasks: Task[]): Opt[] {
  if (field === "status") {
    return SELECTABLE_STATUSES.map((s) => ({ value: s.v, label: statusLabel(s.v), color: s.color }));
  }
  const set = new Set<string>();
  for (const t of tasks) {
    if (field === "project") {
      if (t.project_name) set.add(t.project_name);
    } else if (field === "episode") {
      if (t.name) set.add(t.name);
    } else if (field === "sequence") {
      if (t.sequence) set.add(t.sequence);
    } else if (field === "creator") {
      for (const c of t.creators || []) set.add(c);
    }
  }
  return [...set].sort().map((v) => ({ value: v, label: v }));
}

export function WorkFilterBar({
  tasks,
  filters,
  onChange,
}: {
  tasks: Task[];
  filters: WorkFilters;
  onChange: (f: WorkFilters) => void;
}) {
  const [openField, setOpenField] = useState<WorkFilterField | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const inactive = WORK_FILTER_FIELDS.filter((f) => !filters.active.includes(f));

  const addField = (f: WorkFilterField) => {
    onChange({ ...filters, active: [...filters.active, f] });
    setAddOpen(false);
    setOpenField(f); // 추가하자마자 값 선택 팝업 열기
  };
  const removeField = (f: WorkFilterField) => {
    onChange({
      ...filters,
      active: filters.active.filter((x) => x !== f),
      values: { ...filters.values, [f]: [] },
    });
    if (openField === f) setOpenField(null);
  };
  const toggleValue = (f: WorkFilterField, v: string) => {
    const cur = filters.values[f];
    const next = cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v];
    onChange({ ...filters, values: { ...filters.values, [f]: next } });
  };

  return (
    <div className="work-filterbar">
      <div className="work-chips">
      {filters.active.map((f) => {
        const sel = filters.values[f];
        return (
          <div key={f} className="work-chip-wrap">
            <button
              className={"work-chip" + (sel.length ? " on" : "")}
              onClick={() => setOpenField((c) => (c === f ? null : f))}
            >
              <span className="work-chip-label">{WORK_FILTER_LABELS[f]}</span>
              {sel.length > 0 && <span className="work-chip-count">{sel.length}</span>}
              <span className="work-chip-caret">▾</span>
            </button>
            <button className="work-chip-x" title="필터 제거" onClick={() => removeField(f)}>
              ✕
            </button>
            {openField === f && (
              <WorkFilterPopup
                opts={optionsFor(f, tasks)}
                selected={sel}
                onToggle={(v) => toggleValue(f, v)}
                onClear={() => onChange({ ...filters, values: { ...filters.values, [f]: [] } })}
                onClose={() => setOpenField(null)}
              />
            )}
          </div>
        );
      })}
      </div>

      {/* 검색 + 필터 추가 — 우측 정렬 */}
      <div className="work-filter-right">
        <div className="work-search">
          <span className="work-search-ic">🔍</span>
          <input
            value={filters.search}
            placeholder="검색"
            onChange={(e) => onChange({ ...filters, search: e.target.value })}
          />
          {filters.search && (
            <button className="work-search-x" title="지우기" onClick={() => onChange({ ...filters, search: "" })}>
              ✕
            </button>
          )}
        </div>
        {inactive.length > 0 && (
          <div className="work-chip-wrap">
            <button className="work-chip work-chip-add" onClick={() => setAddOpen((o) => !o)}>
              + 필터
            </button>
            {addOpen && (
              <>
                <div className="work-pop-backdrop" onClick={() => setAddOpen(false)} />
                <div className="work-pop work-pop-add work-pop-right">
                  <div className="work-pop-head">필터 기준</div>
                  {inactive.map((f) => (
                    <button key={f} className="work-pop-item" onClick={() => addField(f)}>
                      {WORK_FILTER_LABELS[f]}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function WorkFilterPopup({
  opts,
  selected,
  onToggle,
  onClear,
  onClose,
}: {
  opts: Opt[];
  selected: string[];
  onToggle: (v: string) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const shown = useMemo(
    () => (q ? opts.filter((o) => o.label.toLowerCase().includes(q.toLowerCase())) : opts),
    [opts, q],
  );
  return (
    <>
      <div className="work-pop-backdrop" onClick={onClose} />
      <div className="work-pop">
        <input
          className="work-pop-search"
          value={q}
          placeholder="값 검색…"
          onChange={(e) => setQ(e.target.value)}
          autoFocus
        />
        <div className="work-pop-list">
          {!shown.length && <div className="work-pop-empty">값 없음</div>}
          {shown.map((o) => (
            <label key={o.value} className="work-pop-opt">
              <input
                type="checkbox"
                checked={selected.includes(o.value)}
                onChange={() => onToggle(o.value)}
              />
              {o.color && <span className="status-dot" style={{ background: o.color }} />}
              <span className="work-pop-opt-txt">{o.label}</span>
            </label>
          ))}
        </div>
        {selected.length > 0 && (
          <button className="work-pop-clear" onClick={onClear}>
            선택 해제 ({selected.length})
          </button>
        )}
      </div>
    </>
  );
}
