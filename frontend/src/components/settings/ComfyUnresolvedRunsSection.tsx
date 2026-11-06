import { useEffect, useState } from "react";
import { useT } from "../../lib/i18n";
import { useComfyUnresolvedRuns } from "../../lib/useComfyUnresolvedRuns";

const PHASE_LABELS: Record<string, string> = {
  submitting: "제출 확인 중", running: "실행 중", unknown: "제출 여부 불명",
  orphaned: "실행 확인 필요", result_pending: "결과 회수 필요", collecting: "결과 회수 중", collected: "로컬 저장 확인 필요",
};

// 설정의 ComfyUI 묶음 안, ComfyUI 칸 아래에 붙은 작은 칸(왼쪽 선 — Jay 2026-11-06 시안 F). onSummary = 묶음 제목 밑 줄에 넣을 미회수 수.
export function ComfyUnresolvedRunsSection({ onSummary }: { onSummary?: (summary: string) => void } = {}) {
  const t = useT();
  const state = useComfyUnresolvedRuns();
  const [confirmed, setConfirmed] = useState<string | null>(null);
  const summary = state.error ? t("미회수 확인 실패")
    : state.runs.length ? t("미회수 {n}건").replace("{n}", String(state.runs.length)) : t("미회수 없음");
  useEffect(() => { onSummary?.(summary); }, [onSummary, summary]);
  return (
    <section className="settings-section comfy-unresolved">
      <h4>{t("미회수 실행")}</h4>
      <button type="button" className="settings-action" disabled={state.busy} onClick={() => void state.refresh()}>{t("다시 조회")}</button>
      <p className="settings-hint">{t("카드가 없어도 실행 기록은 여기에 남습니다. 목록 확인은 원격 서비스를 호출하지 않습니다.")}</p>
      {state.error && <p role="alert" className="settings-hint">{state.error}</p>}
      {!!state.foreignCount && <p role="note" className="settings-hint">{t("원래 PC 에서 확인 필요")} · {state.foreignCount}</p>}
      {!state.runs.length && !state.error && <p className="settings-hint">{t("미회수 실행이 없습니다.")}</p>}
      <div style={{ maxHeight: 360, overflowY: "auto" }}>
        {state.runs.map((run) => (
          <div key={run.job_id} style={{ borderTop: "1px solid var(--line, #333)", padding: "10px 0", overflowWrap: "anywhere" }}>
            <strong>{t(PHASE_LABELS[run.phase] || "실행 확인 필요")}</strong>
            <p className="settings-hint">{run.target_kind} · {run.job_id}</p>
            {run.prompt_id && <p className="settings-hint">{t("원격 작업 ID")}: {run.prompt_id}</p>}
            {run.phase === "unknown" && <p role="note" className="settings-hint">{t("원격 서비스가 이미 접수했을 수 있습니다. 같은 계정에서 직접 확인하고 다시 생성하지 마세요.")}</p>}
            {!run.device_matches_current && <p className="settings-hint">{t("실행한 계정과 PC에서 확인하세요.")}</p>}
            {run.device_matches_current && !run.target_matches_current && run.phase !== "collected" && <p className="settings-hint">{t("결과 회수에는 실행 당시 연결 설정이 필요합니다. 로컬 재저장은 연결 변경과 무관합니다.")}</p>}
            <p className="settings-hint">{t("받은 결과 {downloaded} · 저장 확인 {acked}")
              .replace("{downloaded}", String(run.outputs.filter((output) => output.downloaded).length))
              .replace("{acked}", String(run.outputs.filter((output) => output.acked).length))}</p>
            {run.outputs.some((output) => output.unavailable) && <p className="settings-hint">{t("일부 원격 결과를 찾을 수 없습니다. 받은 결과는 저장하고 기록 정리는 직접 결정하세요.")}</p>}
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {run.can_collect && <button type="button" disabled={state.busy} onClick={() => void state.collect(run)}>{t("결과 회수 · 새 생성 요청 없음")}</button>}
              {run.can_resave && <button type="button" disabled={state.busy} onClick={() => void state.resave(run)}>{t("내 작업에 저장 · 원격 호출 없음")}</button>}
            </div>
            {run.can_dismiss && <div style={{ marginTop: 8 }}>
              <label><input type="checkbox" checked={confirmed === run.job_id} disabled={state.busy}
                onChange={(event) => setConfirmed(event.target.checked ? run.job_id : null)} />
                {t("원격 상태를 확인했으며 이 복구 기록을 정리합니다. 원격 작업은 취소되지 않습니다.")}</label>
              <button type="button" disabled={state.busy || confirmed !== run.job_id} onClick={() => {
                setConfirmed(null); void state.dismiss(run);
              }}>{t("기록 정리")}</button>
            </div>}
          </div>
        ))}
      </div>
    </section>
  );
}
