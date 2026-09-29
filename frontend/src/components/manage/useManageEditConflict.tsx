import { useEffect, useRef, useState } from "react";
import { HttpError } from "../../lib/http";
import { manageApi } from "../../lib/manageApi";
import type { CreditPlanSaveBody, CreditPlanSettings } from "../../lib/creditPlan";
import { editFieldLabel, editValueLabel, mergeCreditPlan, mergePlanning, type EditChange, type EditMerge, type MergeChoices } from "../../lib/creditPlanMerge";
import type { Planning } from "./types";

interface ConflictDetail<T> {
  kind: "manage_edit_conflict";
  latest: T;
  latest_revision: number;
  changes: { revision: number; actor_uid: string | null; actor_name: string | null; fields: string[]; created_at: string }[];
  history_complete: boolean;
}

// Only this feature decodes the structured detail; shared HTTP errors remain strings.
export function parseManageConflict<T>(reason: unknown): ConflictDetail<T> | null {
  if (!(reason instanceof HttpError) || reason.status !== 409 || !reason.detail) return null;
  try {
    const data = JSON.parse(reason.detail);
    if (data?.kind !== "manage_edit_conflict" || !data.latest || typeof data.latest !== "object" || !Number.isInteger(data.latest_revision) || data.latest_revision < 0 || !Array.isArray(data.changes)) return null;
    if (!data.changes.every((change: ConflictDetail<T>["changes"][number]) => change && Number.isInteger(change.revision) && Array.isArray(change.fields) && change.fields.every((field) => typeof field === "string"))) return null;
    return { ...data, history_complete: data.history_complete === true };
  } catch { return null; }
}

interface Prompt {
  detail: ConflictDetail<unknown>;
  changes: EditChange[];
  resolve: (choices: MergeChoices | null) => void;
}
export class ManageEditCancelled extends Error {
  constructor() { super("저장을 취소했습니다. 입력은 유지되며 다른 관리자의 서버 변경은 되돌리지 않았습니다."); }
}

function ConflictDialog({ prompt }: { prompt: Prompt }) {
  const [choices, setChoices] = useState<MergeChoices>({});
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    cancelRef.current?.focus();
    // Stop same-target listeners too, so Escape cannot close the editor underneath.
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Tab") {
        const controls = [...(dialogRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled), select:not(:disabled)") ?? [])];
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
      if (event.key !== "Escape") return;
      event.preventDefault(); event.stopImmediatePropagation(); prompt.resolve(null);
    };
    window.addEventListener("keydown", escape, true);
    return () => { window.removeEventListener("keydown", escape, true); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [prompt]);
  const overlaps = prompt.changes.filter((change) => change.conflict);
  return <div className="credit-modal-backdrop manage-conflict-backdrop" onMouseDown={(event) => { event.stopPropagation(); if (event.target === event.currentTarget) prompt.resolve(null); }}>
    <div ref={dialogRef} className="credit-modal manage-conflict" role="dialog" aria-modal="true" aria-label="동시 수정 확인">
      <h4>다른 관리자가 먼저 저장했습니다</h4>
      {!prompt.detail.history_complete ? <p role="status">변경 이력이 일부 없어 변경자를 모두 확인할 수 없습니다.</p> : null}
      <ul className="manage-conflict-history">{prompt.detail.changes.map((change, index) => <li key={`${change.revision}-${index}`}>
        <strong>{change.actor_name || change.actor_uid || "변경자 미상"}</strong> · {change.created_at} · r{change.revision}
        <div>{change.fields.map(editFieldLabel).join(", ") || "항목 미상"}</div>
      </li>)}</ul>
      <div className="manage-conflict-scroll"><table>
        <thead><tr><th>항목</th><th>편집 시작값</th><th>서버 최신값</th><th>내 입력</th><th>반영할 값</th></tr></thead>
        <tbody>{prompt.changes.map((change) => <tr key={change.path}>
          <th>{change.label ?? editFieldLabel(change.path)}</th><td>{editValueLabel(change.before)}</td><td>{editValueLabel(change.remote)}</td><td>{editValueLabel(change.mine)}</td>
          <td>{change.conflict ? <select aria-label={`${editFieldLabel(change.path)} 충돌 선택`} value={choices[change.path] ?? ""} onChange={(event) => setChoices((current) => ({ ...current, [change.path]: event.target.value as "mine" | "remote" }))}>
            <option value="" disabled>선택 필요</option><option value="remote">서버 변경 적용</option><option value="mine">{change.remote === undefined && change.mine !== undefined ? "내 입력으로 복원" : change.mine === undefined ? "내 삭제 유지" : "내 입력 유지"}</option>
          </select> : "서버 변경 보존"}</td>
        </tr>)}</tbody>
      </table></div>
      <div className="credit-modal-actions">
        <button type="button" className="admin-confirm-yes" disabled={overlaps.some((change) => !choices[change.path])} onClick={() => prompt.resolve(choices)}>선택한 값으로 저장</button>
        <button ref={cancelRef} type="button" className="credit-modal-delete" onClick={() => prompt.resolve(null)}>취소 · 입력 유지</button>
      </div>
    </div>
  </div>;
}

export function useManageEditConflict() {
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const pending = useRef<((choices: MergeChoices | null) => void) | null>(null);
  useEffect(() => () => pending.current?.(null), []);
  const ask = (detail: ConflictDetail<unknown>, changes: EditChange[]) => new Promise<MergeChoices | null>((resolve) => {
    pending.current?.(null);
    const finish = (choices: MergeChoices | null) => { pending.current = null; setPrompt(null); resolve(choices); };
    pending.current = finish;
    setPrompt({ detail, changes, resolve: finish });
  });

  async function save<T, B extends { revision?: number }>(baseline: T, initial: B, write: (body: B) => Promise<T>, merge: (base: T, mine: B, latest: T, choices?: MergeChoices) => EditMerge<B>, withRevision: (latest: T, revision: number) => T): Promise<T> {
    let base = baseline, body = initial;
    let retriedUnchanged = false;
    for (;;) {
      try { return await write(body); }
      catch (reason) {
        const detail = parseManageConflict<T>(reason);
        if (!detail) throw reason;
        const latest = withRevision(detail.latest, detail.latest_revision);
        const result = merge(base, body, latest);
        if (!result.changes.length) {
          if (retriedUnchanged || detail.latest_revision <= (body.revision ?? 0)) {
            throw new Error("저장 버전을 확정하지 못해 자동 재시도를 중단했습니다. 입력은 유지됩니다. 다시 저장해 주세요.");
          }
          // A separate own topup save can advance only the revision. Compare first,
          // then retry once; never carry this exception over to actual changes.
          retriedUnchanged = true;
          body = result.value;
          base = latest;
          continue;
        }
        const choices = await ask(detail, result.changes);
        if (!choices) throw new ManageEditCancelled();
        body = merge(base, body, latest, choices).value;
        base = latest; // Actual changes advance only after an explicit decision.
      }
    }
  }
  return {
    dialog: prompt ? <ConflictDialog key={prompt.detail.latest_revision} prompt={prompt} /> : null,
    active: !!prompt,
    saveCredit: (workspaceId: string, baseline: CreditPlanSettings, body: CreditPlanSaveBody) => save(baseline, { ...body, revision: baseline.plan.revision }, (value) => manageApi.saveCreditPlan(workspaceId, value), mergeCreditPlan, (latest, revision) => {
      if (latest.workspace_id !== workspaceId || !latest.plan || !Array.isArray(latest.groups) || !Array.isArray(latest.members) || !Array.isArray(latest.topups)) throw new Error("충돌 응답의 워크스페이스 설정을 확인할 수 없습니다. 입력은 유지됩니다.");
      return { ...latest, plan: { ...latest.plan, revision } };
    }),
    savePlanning: (projectId: string, baseline: Planning, body: Planning) => save(baseline, { ...body, revision: baseline.revision ?? 0 }, (value) => manageApi.setPlanning(projectId, value), mergePlanning, (latest, revision) => {
      if (latest.project_id && latest.project_id !== projectId || "plan" in latest) throw new Error("충돌 응답의 프로젝트를 확인할 수 없습니다. 입력은 유지됩니다.");
      return { ...latest, revision };
    }),
  };
}
