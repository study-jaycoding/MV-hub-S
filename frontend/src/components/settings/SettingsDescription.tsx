import type { ReactNode } from "react";
import { useT } from "../../lib/i18n";

export function SettingsDescription({
  summary,
  children,
}: {
  summary: ReactNode;
  children?: ReactNode;
}) {
  const t = useT();
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
            <span className="settings-more-open">{t("더보기")}</span>
            <span className="settings-more-close">{t("접기")}</span>
          </summary>
          <div className="settings-help-content">{children}</div>
        </details>
      )}
    </div>
  );
}
