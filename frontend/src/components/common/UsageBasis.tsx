import { useT } from "../../lib/i18n";
import { usageBasisText, usagePeriodText, type UsageBasis as Basis } from "../../lib/creditUsage";

export function UsageBasis({ value }: { value?: Basis | null }) {
  const t = useT();
  if (!value?.basis) return null;
  return <small className="credit-usage-basis" title={value?.components?.map(p => `${usageBasisText(p, t)} · ${usagePeriodText(p)}`).join("\n")}>
    {usageBasisText(value, t)}
    {usagePeriodText(value) && <> · {usagePeriodText(value)}</>}
    {value?.collected_at_ms != null && <> · {t("수집 시각")} {new Date(value.collected_at_ms).toLocaleString()}</>}
  </small>;
}
