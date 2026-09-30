// 대시보드 머리의 워크스페이스 선택 — 서브스페이스 머리(이름 + 메인/서브 칩)와 같은 모양, 펼치면 서브스페이스 메뉴와 같은 판.
// 메인·서브 칩은 선택 단추 **밖**, 이름 옆(Jay 2026-09-30). 목록은 묶음 제목 없이 줄마다 이름 옆 칩, 순서는 서브스페이스 왼쪽 목록과 같게
// (/api/manage/workspaces 의 console_tier·console_order). 서브스페이스에 없는 워크스페이스는 뒤에 이름순, 구서버면 이름순 그대로.
import { useState } from "react";
import { useEscapeClose } from "../../lib/useEscapeClose";
import type { WorkspaceOption } from "../../types";

type Item = { id: string; name: string; tier: "main" | "sub" | null; order: number | null; members: number | null };

const initial = (name: string) => name.trim().slice(0, 1).toUpperCase() || "?";

function Chevron({ open }: { open: boolean }) {
  // 브라우저 기본 선택 상자의 열기 화살표만큼 크게·굵게(Jay 2026-09-30)
  return (
    <svg className="ws-picker-chevron" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d={open ? "M4 10l4-4 4 4" : "M4 6l4 4 4-4"} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function TierChip({ tier }: { tier: Item["tier"] }) {
  if (tier === "main") return <span className="wc-chip ok">메인</span>;
  if (tier === "sub") return <span className="wc-chip">서브</span>;
  return null;
}

export function WorkspacePicker({ workspaces, labels, value, onChange }: {
  workspaces: WorkspaceOption[];
  labels: Map<string, string>; // 같은 이름 구분용 표시 이름(workspaceCommandLabels)
  value: string; // "" = 개인 · 전체 워크스페이스
  onChange: (id: string | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  useEscapeClose(() => setOpen(false), open);

  const items: Item[] = workspaces
    .map((w) => ({ id: w.id, name: labels.get(w.id) ?? w.name, tier: w.console_tier ?? null, order: w.console_order ?? null, members: w.member_count }))
    // 서브스페이스 순서가 있는 것(메인·연결된 서브)이 먼저 그 순서대로, 나머지는 받은 순서(이름순) 그대로 — sort 는 안정 정렬
    .sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity));
  if (value && !items.some((item) => item.id === value)) {
    items.unshift({ id: value, name: `선택 워크스페이스 (${value.slice(0, 8)})`, tier: null, order: null, members: null });
  }
  const current = items.find((item) => item.id === value);
  const pick = (id: string) => { setOpen(false); if (id !== value) onChange(id || undefined); };

  return (
    <div className="ws-picker">
      <button type="button" className={`ws-picker-button${open ? " open" : ""}`} aria-label="워크스페이스 선택" aria-haspopup="listbox" aria-expanded={open}
        onClick={() => setOpen(!open)}>
        <span className="ws-picker-title">{current ? current.name : "개인 · 전체 워크스페이스"}</span>
        <Chevron open={open} />
      </button>
      {current ? <TierChip tier={current.tier} /> : null}
      {open ? (
        <>
          <div className="wc-menu-backdrop" onClick={() => setOpen(false)} />
          <div className="ws-picker-menu" role="listbox" aria-label="워크스페이스">
            <button type="button" role="option" aria-selected={!value} className={`ws-picker-item${!value ? " on" : ""}`} onClick={() => pick("")}>
              <span className="ws-picker-mini all">전</span><span className="ws-picker-name">개인 · 전체 워크스페이스</span>
              <span className="ws-picker-check">{!value ? "✓" : ""}</span>
            </button>
            <div className="ws-picker-sep" />
            {items.map((item) => (
              <button key={item.id} type="button" role="option" aria-selected={item.id === value}
                className={`ws-picker-item${item.id === value ? " on" : ""}`} onClick={() => pick(item.id)}>
                <span className="ws-picker-mini">{initial(item.name)}</span>
                <span className="ws-picker-name">{item.name}</span>
                <TierChip tier={item.tier} />
                <span className="ws-picker-meta">{item.members != null ? `${item.members}명` : ""}</span>
                <span className="ws-picker-check">{item.id === value ? "✓" : ""}</span>
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
