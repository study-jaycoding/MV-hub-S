import { useId, useState, type ReactNode } from "react";

// 설정 옆 패널의 크게 접는 묶음(Jay 2026-11-06 시안 F) — 처음엔 접혀 있고 열림을 기억하지 않는다(옆 패널을 열 때마다 모두 접힘).
//  제목 밑 summary 는 접어 둬도 늘 보인다("실시간 정보는 접기 밖" 규칙, Jay 08-20).
//  본문은 늘 붙여 두고 hidden 으로만 숨긴다 — 칸들의 상태 불러오기(Resolve·Comfy·Slack 조회)가 펼치기 전에도 지금처럼 돈다.
//  hideFirstTitle = 묶음 제목과 같은 첫 칸의 제목(h4)을 숨긴다(ComfyUI 안의 'ComfyUI' 등).
export function SettingsFold({
  title,
  summary,
  hideFirstTitle,
  children,
}: {
  title: string;
  summary?: ReactNode;
  hideFirstTitle?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  return (
    <div className={"settings-fold" + (open ? " is-open" : "") + (hideFirstTitle ? " hide-first-title" : "")}>
      <button type="button" className="settings-fold-head" aria-expanded={open} aria-controls={bodyId}
        onClick={() => setOpen((was) => !was)}>
        <span className="settings-fold-text">
          <span className="settings-fold-title">{title}</span>
          {summary ? <span className="settings-fold-summary">{summary}</span> : null}
        </span>
        <svg className="settings-fold-chev" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      <div id={bodyId} className="settings-fold-body" hidden={!open}>
        {children}
      </div>
    </div>
  );
}
