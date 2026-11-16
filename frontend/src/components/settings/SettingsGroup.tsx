import { createContext, useId, type ReactNode } from "react";

/** 묶음이 펼쳐져 있는지 — 안의 항목(SettingsFold)이 읽어, 묶음을 접으면 열려 있던 자기 옆 창을 닫는다. */
export const SettingsGroupOpen = createContext(true);

// 설정 창 바깥의 묶음 줄(Jay 2026-11-16 시안 v3) — 누르면 그 밑으로 항목들이 펼쳐지고, 항목을 누르면 옆 창.
//  접힌 줄에는 안의 항목 이름 한 줄. 안의 항목은 접혀 있어도 붙여 둔다(hidden) — 칸들의 상태 조회가 펼치기 전에도 돈다.
export function SettingsGroup({
  title,
  summary,
  open,
  onToggle,
  children,
}: {
  title: string;
  summary?: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const subId = useId();
  return (
    <section className={"settings-group" + (open ? " is-open" : "")}>
      <button type="button" className="settings-group-toggle" aria-expanded={open} aria-controls={subId} onClick={onToggle}>
        <span className="settings-group-text">
          <span className="settings-group-title">{title}</span>
          {!open && summary ? <span className="settings-group-summary">{summary}</span> : null}
        </span>
        <svg className="settings-group-chevron" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      <div id={subId} className="settings-group-sub" hidden={!open}>
        <SettingsGroupOpen.Provider value={open}>{children}</SettingsGroupOpen.Provider>
      </div>
    </section>
  );
}
