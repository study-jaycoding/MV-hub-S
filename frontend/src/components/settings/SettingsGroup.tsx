import type { KeyboardEvent } from "react";

// 설정 창 바깥의 묶음 줄(Jay 2026-11-16 '같은 창에서 목록, 항목은 옆 창') — 누르면 옆 창이 아니라 같은 창이 그 묶음의 목록으로 바뀐다.
//  목록 화면(머리의 ‹ 뒤로·묶음 이름)과 목록의 각 항목(SettingsFold)은 SettingsPanel 이 그린다.
export function SettingsGroup({
  title,
  summary,
  page,
  onOpen,
}: {
  title: string;
  summary?: string;
  /** 뒤로 왔을 때 초점을 이 줄로 되돌리는 표지 */
  page: string;
  onOpen: () => void;
}) {
  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      onOpen();
    }
  };
  return (
    <section className="settings-group">
      <button type="button" className="settings-group-toggle" data-settings-page={page} onClick={onOpen} onKeyDown={handleKeyDown}>
        <span className="settings-group-text">
          <span className="settings-group-title">{title}</span>
          {summary ? <span className="settings-group-summary">{summary}</span> : null}
        </span>
        <span className="settings-group-chevron" aria-hidden="true">›</span>
      </button>
    </section>
  );
}
