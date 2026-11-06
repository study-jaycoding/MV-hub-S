import type { ReactNode } from "react";
import { useT } from "../../lib/i18n";

export function SettingsDescription({
  summary,
  children,
}: {
  summary?: ReactNode; // 없으면 더보기만 — 요약을 접는 묶음 제목 밑으로 올린 칸(Slack)
  children?: ReactNode;
}) {
  const t = useT();
  return (
    <div className="settings-description">
      {summary !== undefined && (
        <p
          className="settings-hint settings-description-summary"
          title={typeof summary === "string" ? summary : undefined}
        >
          {summary}
        </p>
      )}
      {children && (
        <details className="settings-help-more">
          <summary>
            <span className="settings-more-open">{t("더보기")}</span>
            <span className="settings-more-close">{t("접기")}</span>
          </summary>
          <div className="settings-help-content">{children}</div>
        </details>
      )}
    </div>
  );
}
