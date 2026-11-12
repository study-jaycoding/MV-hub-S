// MV Agent 칸의 계획 카드 — 계획만이면 [실행]·[고치기], 보냈으면(AI 실행 또는 사람 [실행]) 항목마다 확인된 상태와 완료 썸네일
//  (앱 동작 도구 설계 A4). 상태는 확인된 출처에서만: 허브가 새로 읽은 스냅샷의 생성 상태 → 앱이 읽은 라이브러리 카드 → 그 밖은 '접수됨'.
import { useEffect, useRef, useState } from "react";
import { api } from "../../api";
import type { AgentPlan } from "../../lib/agentChatApi";
import { useT } from "../../lib/i18n";
import { thumbOf } from "../../lib/media";
import { useModelDisplayName } from "../../lib/modelCatalog";
import type { AgentMessage, AgentPlanProgress } from "../../lib/useAgentChat";
import type { Generation, PreviewTarget } from "../../types";

type PlanMessage = Extract<AgentMessage, { kind: "plan" }>;
interface Props {
  plan: AgentPlan;
  exec?: PlanMessage["exec"];
  estimate?: PlanMessage["estimate"];
  progress?: AgentPlanProgress;
  onExecute: () => void;
  onRevise: () => void;
  findGeneration?: (id: string) => Generation | undefined; // 앱이 이미 읽은 라이브러리 카드(같은 계정 — 진행 소켓이 갱신)
  onPreview?: (target: PreviewTarget) => void;
}

export type ItemKind = "done" | "making" | "failed" | "rejected" | "missing" | "accepted" | "sending" | "unsent" | "unconfirmed";
const LABEL: Record<ItemKind, string> = {
  done: "완료", making: "만드는 중", failed: "실패", rejected: "거절", missing: "결과 없음", accepted: "접수됨",
  sending: "보내는 중", unsent: "미제출", unconfirmed: "접수 확인 안 됨",
};
const SETTLED: ReadonlySet<ItemKind> = new Set(["done", "failed", "rejected", "missing", "unsent"]);
const genSettled = (s?: string | null) => !!s && s !== "pending" && s !== "running";

/** 항목 하나의 칸 글 — server = 스냅샷의 생성 상태(없으면 확인 못 함), library = 앱이 읽은 카드의 상태. 완료라고 확인되지 않으면 완료라 하지 않는다. */
export function itemKind(state: string | null | undefined, server: string | null | undefined, library: string | null | undefined,
  planStatus?: string | null): ItemKind {
  if (state === "rejected") return "rejected";
  if (state === "uncertain") return "unconfirmed";
  if (state === "submitting") return "sending";
  if (state == null) return "accepted"; // 항목 상태를 싣지 않은 옛 응답 — 안 보냈다고 단정하지 않는다
  // pending: 계획이 아직 보내는 중(executing)이면 보낼 차례, 끝난 뒤면 앞 항목 거절 등으로 안 보냄(독립 리뷰 P1)
  if (state !== "submitted") return planStatus === "executing" ? "sending" : "unsent";
  const status = genSettled(library) ? library : server ?? library;
  if (status === "missing") return "missing";
  if (status === "done") return "done";
  if (status === "pending" || status === "running") return "making";
  return status ? "failed" : "accepted";
}

/** 항목 설정 칩 — 허브가 싣는 보이기용 세 개(비율·해상도·길이)를 이 순서로. 옛 카드(설정 없음)는 칩 없음. */
function settingChips(params?: Record<string, string | number> | null): string[] {
  return (["aspect_ratio", "resolution", "duration"] as const).flatMap((key) => {
    const value = params?.[key];
    if (typeof value !== "string" && typeof value !== "number") return [];
    return [key === "duration" ? `${value}s` : String(value)];
  });
}

function workspaceLabel(value: unknown): string {
  if (typeof value === "string") return value;
  const ws = value as { scope?: string; name?: string | null } | null;
  return ws?.name || (ws?.scope === "personal" ? "내 공간" : "");
}

function isSent(progress?: AgentPlanProgress): boolean {
  if (!progress) return false;
  if (progress.planStatus && progress.planStatus !== "planned") return true;
  return Object.values(progress.items).some((it) => it.state && it.state !== "pending");
}

export function AgentPlanCard({ plan, exec, estimate, progress, onExecute, onRevise, findGeneration, onPreview }: Props) {
  const t = useT();
  const modelName = useModelDisplayName(); // 모델 코드(nano_banana_flash) 대신 앱의 이름표(Nano Banana 2)
  const items = plan.items ?? [];
  const where = workspaceLabel(plan.workspace);
  const running = exec?.state === "running";
  const sent = exec?.state === "done" || isSent(progress);
  // 포크로 복사한 카드 — 이 대화에서 실행·견적하지 않고, 새 소식이 오지 않아 도는 표시도 없다(docs/status/MVAgent_포크_2026-11-12.md 2-4)
  const forked = !!plan.forked;
  const [fetched, setFetched] = useState<Record<string, Generation | null>>({}); // null = 못 읽음

  const rows = items.map((_, index) => {
    const it = progress?.items[index];
    const genId = it?.generation_id ?? null;
    const known = genId ? findGeneration?.(genId) : undefined;
    const kind = itemKind(it?.state, it?.generation_status, known?.status, progress?.planStatus);
    return { index, genId, kind, gen: known ?? (genId ? fetched[genId] ?? undefined : undefined) };
  });
  // 완료로 확인됐는데 앱이 읽은 목록에 없으면(다른 폴더) 항목마다 한 번만 읽어 썸네일을 얻는다 —
  //  다른 항목 응답이 먼저 와도 진행 중 조회를 버리거나 다시 내지 않는다(독립 리뷰 P2)
  const requested = useRef(new Set<string>());
  const missingThumbs = rows.filter((r) => r.kind === "done" && r.genId && !r.gen && !(r.genId in fetched)).map((r) => r.genId as string);
  const missingKey = missingThumbs.join(",");
  useEffect(() => {
    for (const id of missingKey ? missingKey.split(",") : []) {
      if (requested.current.has(id)) continue;
      requested.current.add(id);
      api.getGeneration(id).then(
        (gen) => setFetched((m) => ({ ...m, [id]: gen })),
        () => setFetched((m) => ({ ...m, [id]: null })),
      );
    }
  }, [missingKey]);

  // 계획이 아직 보내는 중이면 끝났다고 하지 않는다(독립 리뷰 P1)
  const settled = sent && progress?.planStatus !== "executing" && rows.length > 0 && rows.every((r) => SETTLED.has(r.kind));
  const count = (...kinds: ItemKind[]) => rows.filter((r) => kinds.includes(r.kind)).length;
  const summary = [
    `${t("완료")} ${count("done")}`, `${t("실패")} ${count("failed", "rejected")}`,
    ...(count("missing") ? [`${t("결과 없음")} ${count("missing")}`] : []),
    ...(count("unsent") ? [`${t("미제출")} ${count("unsent")}`] : []),
  ].join(" · ");

  const open = (gen: Generation) => {
    const asset = gen.assets?.[0];
    if (asset && onPreview) {
      onPreview({ url: asset.file_path, type: asset.type, name: gen.prompt.slice(0, 50) || "(제목 없음)", genId: gen.id, thumb: thumbOf(gen, 512) });
    }
  };

  return (
    <section className="agent-plan" aria-label={t("계획")}>
      <h4 className="agent-plan-title"><span className="agent-plan-tag">{t("계획")}</span>
        {forked && <span className="agent-plan-tag forked">{t("포크 전")}</span>}{plan.title || t("이름 없는 계획")}</h4>
      {sent && (
        <>
          <p className={`agent-plan-sent${settled ? " is-settled" : ""}`} role="status">
            {settled ? `${t("끝났어요")} · ${summary}` : t("생성을 보냈어요")}
          </p>
          <div className="agent-plan-tiles">
            {rows.map((r) => {
              const thumb = r.gen ? thumbOf(r.gen, 256) : null;
              if (r.kind === "done" && r.gen && thumb) {
                return (
                  <button key={r.index} type="button" className="agent-plan-tile is-done" onClick={() => open(r.gen as Generation)}
                    aria-label={`${t("크게 보기")} — ${r.index + 1}`}>
                    <img src={thumb} alt="" loading="lazy" />
                    <span className="agent-plan-tile-st">{t("완료")}</span>
                  </button>
                );
              }
              const text = r.kind === "done" ? t("완료 — 라이브러리에서 확인") : t(LABEL[r.kind]);
              // 썸네일 없는 완료는 누를 수 없다 — is-done(확대 커서)과 구분
              return (
                <div key={r.index} className={`agent-plan-tile is-${r.kind === "done" ? "nothumb" : r.kind}`} role="img"
                  aria-label={`${r.index + 1}: ${text}`}>
                  {!forked && (r.kind === "making" || r.kind === "sending") && <span className="agent-plan-spin" aria-hidden="true" />}
                  <span>{text}</span>
                </div>
              );
            })}
          </div>
        </>
      )}
      {items.length > 0 && (
        <ol className="agent-plan-items">
          {items.map((item, i) => (
            <li key={i}>
              <span className="agent-plan-num" aria-hidden="true">{i + 1}</span>
              <div className="agent-plan-it">
                <div className="agent-plan-it-head">
                  {item.model && <b>{modelName(item.model)}</b>}
                  {settingChips(item.params).map((chip) => <span key={chip} className="agent-plan-chip">{chip}</span>)}
                </div>
                {item.prompt && <p className="agent-plan-prompt">{item.prompt}</p>}
              </div>
            </li>
          ))}
        </ol>
      )}
      {/* 저장 위치·예상 크레딧 한 줄 */}
      <p className="agent-plan-meta">
        {where && <><span className="agent-plan-where">{t("저장 위치")} <b>{where}</b></span>{!forked && <span className="agent-plan-dot" aria-hidden="true">·</span>}</>}
        {!forked && (
          <span className="agent-plan-cost">
            {!estimate ? t("예상 크레딧 확인 중")
              : estimate.credits === null ? <>{t("예상 크레딧")} {t("확인하지 못했어요")}</>
              : <>{t("예상 크레딧")} <b>{estimate.credits}</b></>}
          </span>
        )}
      </p>
      {forked ? (
        <p className="agent-plan-meta agent-plan-forked">{t("포크 전 상태 · 결과는 라이브러리에서 확인하세요")}</p>
      ) : sent ? (
        exec?.state === "failed" && <p className="agent-plan-fail" role="alert">{exec.message}</p>
      ) : (
        <>
          <p className="agent-plan-warn"><WarnIcon />{t("실행하면 크레딧이 나갑니다")}</p>
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

function WarnIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3 2.5 20h19Z" />
      <path d="M12 10v4.5M12 17.2v.3" />
    </svg>
  );
}
