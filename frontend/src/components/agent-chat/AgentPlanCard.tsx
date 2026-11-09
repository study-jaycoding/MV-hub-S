// Ask Agent 칸의 계획 카드 — 에이전트는 계획까지만 저장하고, 크레딧이 나가는 [실행]은 사람이 여기서 누른다(설계 3-3).
import type { AgentPlan } from "../../lib/agentChatApi";
import { useT } from "../../lib/i18n";
import type { AgentMessage } from "../../lib/useAgentChat";

interface Props {
  plan: AgentPlan;
  exec?: Extract<AgentMessage, { kind: "plan" }>["exec"];
  estimate?: Extract<AgentMessage, { kind: "plan" }>["estimate"];
  onExecute: () => void;
  onRevise: () => void;
}

// 계획의 저장 위치 — 허브가 글이나 {scope, name} 으로 준다
function workspaceLabel(value: unknown): string {
  if (typeof value === "string") return value;
  const ws = value as { scope?: string; name?: string | null } | null;
  return ws?.name || (ws?.scope === "personal" ? "내 공간" : "");
}

export function AgentPlanCard({ plan, exec, estimate, onExecute, onRevise }: Props) {
  const t = useT();
  const items = plan.items ?? [];
  const where = workspaceLabel(plan.workspace);
  const running = exec?.state === "running";
  return (
    <section className="agent-plan" aria-label={t("계획")}>
      <h4 className="agent-plan-title">{t("계획")} — {plan.title || t("이름 없는 계획")}</h4>
      {items.length > 0 && (
        <ul className="agent-plan-items">
          {items.map((item, i) => (
            <li key={i}>
              {item.model && <b>{item.model}</b>}
              {item.prompt && <span>{item.prompt}</span>}
            </li>
          ))}
        </ul>
      )}
      {where && <p className="agent-plan-where">{t("저장 위치")}: {where}</p>}
      <p className="agent-plan-cost">
        {!estimate ? t("예상 크레딧 확인 중")
          : estimate.credits === null ? t("예상 크레딧: 확인하지 못했어요")
          : `${t("예상 크레딧")}: ${estimate.credits}`}
      </p>
      {exec?.state === "done" ? (
        <p className="agent-plan-done" role="status">{t("실행을 보냈어요 — 결과는 라이브러리에 들어와요")}</p>
      ) : (
        <>
          <p className="agent-plan-warn">{t("실행하면 크레딧이 나갑니다")}</p>
          {exec?.state === "failed" && <p className="agent-plan-fail" role="alert">{exec.message}</p>}
          <div className="agent-plan-actions">
            <button type="button" className="agent-plan-run" onClick={onExecute} disabled={running}
              aria-label={running ? t("실행하는 중") : t("계획 실행 — 크레딧이 나갑니다")}>
              {running ? t("실행하는 중") : t("실행")}
            </button>
            <button type="button" className="agent-plan-fix" onClick={onRevise} disabled={running} aria-label={t("계획 고치기")}>
              {t("고치기")}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
