import type { ReactNode } from "react";

export function SettingsDescription({
  summary,
  children,
}: {
  summary: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="settings-description">
      <p
        className="settings-hint settings-description-summary"
        title={typeof summary === "string" ? summary : undefined}
      >
        {summary}
      </p>
      {children && (
        <details className="settings-help-more">
          <summary>
            <span className="settings-more-open">더보기</span>
            <span className="settings-more-close">접기</span>
          </summary>
          <div className="settings-help-content">{children}</div>
        </details>
      )}
    </div>
  );
}
