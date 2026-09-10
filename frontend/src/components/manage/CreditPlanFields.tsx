// 프로젝트 설정 창의 '크레딧 풀 · 그룹' 절 — 워크스페이스 단위 설정(월 충전·그룹 월 한도·멤버 배정).
// 힉스필드 관리 창의 User Group 과 이름을 똑같이 적어 두는 대조표. 저장은 ProjectManagerPanel 이 별도 PUT 으로
// (revision 낙관적 잠금 — 다른 창에서 먼저 저장했으면 409). 초안 상태는 부모(다이얼로그 state)가 들고 있다.
import { useEffect, useState } from "react";
import { isHttpStatus, isRouteMissing } from "../../lib/http";
import { manageApi } from "../../lib/manageApi";
import { draftFromSettings, type CreditPlanDraft, type DraftGroup } from "../../lib/creditPlan";

function n(value: number | null): string {
  return value == null ? "∞" : Math.round(value).toLocaleString();
}

export function CreditPlanFields({
  workspaceId,
  draft,
  onChange,
}: {
  workspaceId: string;
  draft: CreditPlanDraft | null;
  onChange: (draft: CreditPlanDraft | null) => void;
}) {
  const [status, setStatus] = useState<"idle" | "loading" | "unsupported" | "error">("idle");
  const [error, setError] = useState("");
  const loaded = draft && draft.loadedFor === workspaceId;

  useEffect(() => {
    if (!workspaceId || loaded) return;
    let active = true;
    setStatus("loading");
    manageApi.creditPlanSettings(workspaceId)
      .then((settings) => {
        if (!active) return;
        onChange(draftFromSettings(settings));
        setStatus("idle");
      })
      .catch((reason) => {
        if (!active) return;
        if (isRouteMissing(reason) || isHttpStatus(reason, 403)) {
          setStatus("unsupported"); // 구서버 또는 권한 없음 — 절을 접는다
          onChange(null);
          return;
        }
        setStatus("error");
        setError(String(reason).replace(/^Error:\s*/, ""));
      });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, loaded]);

  if (!workspaceId || status === "unsupported") return null;

  const update = (patch: Partial<CreditPlanDraft>) => {
    if (!draft) return;
    onChange({ ...draft, ...patch, dirty: true });
  };
  const updateGroup = (index: number, patch: Partial<DraftGroup>) => {
    if (!draft) return;
    update({ groups: draft.groups.map((group, i) => (i === index ? { ...group, ...patch } : group)) });
  };
  const removeGroup = (index: number) => {
    if (!draft) return;
    const removed = draft.groups[index];
    update({
      groups: draft.groups.filter((_, i) => i !== index),
      members: draft.members.map((member) =>
        removed.id && member.group_id === removed.id ? { ...member, group_id: null } : member),
    });
  };
  const addGroup = () => {
    if (!draft) return;
    update({ groups: [...draft.groups, { name: "", limitInput: "", unlimited: false, overrideInput: "", remaining: null, usedMonth: 0 }] });
  };
  const hasNewGroups = Boolean(draft?.groups.some((group) => !group.id));

  return (
    <section className="project-settings-section credit-plan-fields">
      <h5>
        크레딧 풀 · 그룹
        <small> 워크스페이스 단위 · 힉스필드 User Group 과 이름을 맞춰 두세요 · 한도 강제는 힉스필드가 합니다</small>
      </h5>
      {status === "loading" && !loaded ? <div className="admin-empty">크레딧 설정 불러오는 중…</div> : null}
      {status === "error" ? <div className="login-error">크레딧 설정을 불러오지 못했습니다. {error}</div> : null}
      {loaded && draft ? (
        <>
          <label className="manage-field">
            <span>월 충전</span>
            <div className="manage-budget-limit">
              <input
                type="number"
                min={0}
                step={100}
                value={draft.topupInput}
                placeholder="예: 20000"
                aria-label="워크스페이스 월 충전 크레딧"
                onChange={(event) => update({ topupInput: event.target.value })}
              />
              <em>크레딧 · 힉스필드에 매달 넣는 양(이월됨)</em>
            </div>
          </label>
          <div className="credit-group-editor">
            <div className="credit-group-row head">
              <span>그룹</span><span>월 한도</span><span>∞</span><span>지금 남은 양</span><span>보정</span><span />
            </div>
            {draft.groups.map((group, index) => (
              <div className="credit-group-row" key={group.id || `new-${index}`}>
                <input
                  className="settings-input"
                  value={group.name}
                  placeholder="예: Artist"
                  aria-label="그룹 이름"
                  onChange={(event) => updateGroup(index, { name: event.target.value })}
                />
                <input
                  className="settings-input"
                  type="number"
                  min={0}
                  step={100}
                  value={group.unlimited ? "" : group.limitInput}
                  disabled={group.unlimited}
                  placeholder={group.unlimited ? "∞" : "예: 5000"}
                  aria-label="그룹 월 한도"
                  onChange={(event) => updateGroup(index, { limitInput: event.target.value })}
                />
                <input
                  type="checkbox"
                  checked={group.unlimited}
                  aria-label="한도 없음"
                  title="한도 없음(∞)"
                  onChange={(event) => updateGroup(index, { unlimited: event.target.checked })}
                />
                <span className="credit-group-remaining" title={`이번 달 사용 ${Math.round(group.usedMonth).toLocaleString()}`}>
                  {group.id ? n(group.remaining) : "저장 후 계산"}
                </span>
                <input
                  className="settings-input"
                  type="number"
                  value={group.overrideInput}
                  placeholder="비우면 유지"
                  title="힉스필드 화면의 남은 양과 다르면 여기에 적어 맞춥니다(이월 포함)"
                  aria-label="남은 양 보정"
                  onChange={(event) => updateGroup(index, { overrideInput: event.target.value })}
                />
                <button type="button" className="credit-group-remove" title="그룹 삭제(배정도 풀림)" onClick={() => removeGroup(index)}>×</button>
              </div>
            ))}
            <button type="button" className="credit-group-add" onClick={addGroup}>+ 그룹</button>
          </div>
          <div className="credit-member-editor">
            <div className="credit-member-head">
              <span>멤버 → 그룹</span>
              <small>{hasNewGroups ? "새 그룹은 저장한 뒤에 배정할 수 있습니다." : "한 사람은 그룹 하나"}</small>
            </div>
            {draft.members.length === 0 ? (
              <div className="admin-empty">이 워크스페이스에서 확인된 멤버가 없습니다.</div>
            ) : null}
            {draft.members.map((member) => (
              <label className={`credit-member-row${member.is_available ? "" : " off"}`} key={member.email}>
                <span>
                  <strong>{member.name}</strong>
                  <small>{member.email}{member.is_available ? "" : " · 접근 불가"}</small>
                </span>
                <select
                  value={member.group_id || ""}
                  aria-label={`${member.name} 그룹`}
                  onChange={(event) => update({
                    members: draft.members.map((item) =>
                      item.email === member.email ? { ...item, group_id: event.target.value || null } : item),
                  })}
                >
                  <option value="">그룹 없음</option>
                  {draft.groups.filter((group) => group.id).map((group) => (
                    <option key={group.id} value={group.id}>{group.name || "(이름 없음)"}</option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        </>
      ) : null}
    </section>
  );
}
