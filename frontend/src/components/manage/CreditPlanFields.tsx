// 프로젝트 설정 창의 '크레딧 풀 · 그룹' 절 — 워크스페이스 단위 설정(월 충전·그룹 월 한도·멤버 배정).
// 힉스필드 관리 창(User Group)과 같은 흐름: 그룹 표 + "그룹 추가" → 그룹 창(이름·한도 없음 토글·월 한도·남은 양 보정 |
// 멤버 목록·멤버 추가). 저장은 ProjectManagerPanel 이 프로젝트 저장 뒤 별도 PUT 으로(revision 낙관적 잠금 — 409).
// 초안 상태는 부모(다이얼로그 state)가 들고, 여기서는 초안만 바꾼다. 숫자 칸은 천 단위 구분으로 보여 준다.
import { useEffect, useState } from "react";
import { isHttpStatus, isRouteMissing } from "../../lib/http";
import { manageApi } from "../../lib/manageApi";
import {
  draftFromSettings,
  draftMemberCount,
  formatThousands,
  mergeTopupsFromServer,
  newGroupId,
  stripThousands,
  todayLocal,
  topupsOnlyBody,
  validateTopup,
  type CreditPlanDraft,
  type CreditPlanMember,
  type DraftGroup,
  type DraftTopup,
} from "../../lib/creditPlan";

function n(value: number | null): string {
  return value == null ? "∞" : Math.round(value).toLocaleString();
}

function memberLabel(member: CreditPlanMember): string {
  return member.name || member.email.split("@")[0];
}

// ── 그룹 창(힉스필드 "Add new group" 과 같은 두 칸 구성) ──────────────────────
function GroupEditor({
  draft,
  group,
  onClose,
  onApply,
  onDelete,
}: {
  draft: CreditPlanDraft;
  group: DraftGroup; // 새 그룹이면 isNew=true 로 미리 만든 것
  onClose: () => void;
  onApply: (next: DraftGroup, memberEmails: string[]) => void;
  onDelete: (() => void) | null;
}) {
  const [name, setName] = useState(group.name);
  const [unlimited, setUnlimited] = useState(group.unlimited);
  const [limitInput, setLimitInput] = useState(group.limitInput);
  const [overrideInput, setOverrideInput] = useState(group.overrideInput);
  const [emails, setEmails] = useState<string[]>(
    () => draft.members.filter((member) => member.group_id === group.id).map((member) => member.email),
  );
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState("");
  const groupName = (id: string | null) => (id ? draft.groups.find((item) => item.id === id)?.name || "" : "");
  const assigned = emails
    .map((email) => draft.members.find((member) => member.email === email))
    .filter((member): member is CreditPlanMember => Boolean(member));
  const candidates = draft.members.filter((member) => !emails.includes(member.email));

  const save = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("그룹 이름을 입력하세요.");
      return;
    }
    if (draft.groups.some((item) => item.id !== group.id && item.name.trim() === trimmed)) {
      setError("같은 이름의 그룹이 이미 있습니다.");
      return;
    }
    if (!unlimited && !stripThousands(limitInput)) {
      setError("월 한도를 입력하거나 '한도 없음'을 켜세요.");
      return;
    }
    onApply(
      { ...group, name: trimmed, unlimited, limitInput: stripThousands(limitInput), overrideInput: overrideInput.trim() },
      emails,
    );
  };

  return (
    <div className="credit-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="credit-modal" role="dialog" aria-label={group.isNew ? "그룹 추가" : "그룹 편집"}>
        <div className="credit-modal-left">
          <h4>{group.isNew ? "그룹 추가" : "그룹 편집"}</h4>
          <label className="credit-modal-field">
            <span>그룹 이름</span>
            <input
              className="settings-input"
              value={name}
              placeholder="예: Producer"
              autoFocus
              onChange={(event) => { setName(event.target.value); setError(""); }}
              onKeyDown={(event) => { if (event.key === "Enter") save(); }}
            />
          </label>
          <label className="credit-modal-toggle">
            <span>한도 없음</span>
            <input type="checkbox" className="credit-switch" checked={unlimited} onChange={(event) => { setUnlimited(event.target.checked); setError(""); }} />
          </label>
          {!unlimited ? (
            <label className="credit-modal-field">
              <span>월 한도</span>
              <div className="manage-budget-limit">
                <input
                  className="settings-input"
                  type="text"
                  inputMode="numeric"
                  value={formatThousands(limitInput)}
                  placeholder="예: 5,000"
                  onChange={(event) => { setLimitInput(stripThousands(event.target.value)); setError(""); }}
                />
                <em>크레딧 / 월 · 이월됨</em>
              </div>
            </label>
          ) : null}
          {!group.isNew ? (
            <div className="credit-modal-remaining">
              <span>지금 남은 양</span>
              <strong>{n(group.remaining)}</strong>
              <em>이번 달 사용 {Math.round(group.usedMonth).toLocaleString()} · 이월 포함 · 저장 후 다시 계산</em>
            </div>
          ) : null}
          {!unlimited ? (
            <label className="credit-modal-field">
              <span>남은 양 보정</span>
              <div className="manage-budget-limit">
                <input
                  className="settings-input"
                  type="text"
                  inputMode="numeric"
                  value={overrideInput.startsWith("-") ? `-${formatThousands(overrideInput.slice(1))}` : formatThousands(overrideInput)}
                  placeholder="비우면 유지"
                  title="힉스필드 화면의 남은 양과 다르면 여기에 적어 맞춥니다(이월 포함)"
                  onChange={(event) => {
                    const raw = event.target.value;
                    const negative = raw.trim().startsWith("-");
                    setOverrideInput(`${negative ? "-" : ""}${stripThousands(raw)}`);
                  }}
                />
                <em>크레딧 · 힉스필드 화면과 맞출 때만</em>
              </div>
            </label>
          ) : null}
          {error ? <div className="login-error">{error}</div> : null}
          <div className="credit-modal-actions">
            <button type="button" className="admin-confirm-yes" onClick={save}>저장</button>
            {onDelete ? (
              <button type="button" className="credit-modal-delete" onClick={() => { if (window.confirm(`'${group.name}' 그룹을 삭제할까요? 배정도 풀립니다.`)) onDelete(); }}>삭제</button>
            ) : null}
          </div>
        </div>
        <div className="credit-modal-right">
          <button type="button" className="credit-modal-close" aria-label="닫기" onClick={onClose}>×</button>
          <div className="credit-modal-members-head">
            <span>멤버 {assigned.length}</span>
            {!picking && candidates.length ? (
              <button type="button" className="credit-modal-add" onClick={() => setPicking(true)}>+ 멤버 추가</button>
            ) : null}
          </div>
          {picking ? (
            <div className="credit-pick">
              <div className="credit-pick-head">
                <span>추가할 멤버를 고르세요 — 다른 그룹에 있으면 옮겨집니다</span>
                <button type="button" onClick={() => setPicking(false)}>완료</button>
              </div>
              {candidates.map((member) => (
                <button
                  type="button"
                  key={member.email}
                  className={`credit-pick-row${member.is_available ? "" : " off"}`}
                  onClick={() => setEmails((current) => [...current, member.email])}
                >
                  <strong>{memberLabel(member)}</strong>
                  <small>
                    {member.email}
                    {member.group_id && member.group_id !== group.id ? ` · 지금 ${groupName(member.group_id)}` : ""}
                    {member.is_available ? "" : " · 접근 불가"}
                  </small>
                </button>
              ))}
              {!candidates.length ? <div className="admin-empty">추가할 멤버가 없습니다.</div> : null}
            </div>
          ) : assigned.length ? (
            <div className="credit-modal-members">
              {assigned.map((member) => (
                <div className={`credit-modal-member${member.is_available ? "" : " off"}`} key={member.email}>
                  <span>
                    <strong>{memberLabel(member)}</strong>
                    <small>{member.email}{member.is_available ? "" : " · 접근 불가"}</small>
                  </span>
                  <button type="button" aria-label="그룹에서 빼기" onClick={() => setEmails((current) => current.filter((email) => email !== member.email))}>×</button>
                </div>
              ))}
            </div>
          ) : (
            <div className="credit-modal-empty">
              <div className="credit-modal-empty-icon" aria-hidden="true">👥</div>
              <strong>아직 멤버가 없습니다</strong>
              <small>멤버를 추가해 이 그룹에 배정하세요</small>
              {candidates.length ? <button type="button" className="credit-modal-add solid" onClick={() => setPicking(true)}>멤버 추가</button> : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── 절 본체 ───────────────────────────────────────────────────────────────
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
  const [editing, setEditing] = useState<DraftGroup | null>(null);
  const [topupBusy, setTopupBusy] = useState("");
  const [topupError, setTopupError] = useState("");
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
  const applyGroup = (next: DraftGroup, memberEmails: string[]) => {
    if (!draft) return;
    const exists = draft.groups.some((group) => group.id === next.id);
    update({
      groups: exists ? draft.groups.map((group) => (group.id === next.id ? next : group)) : [...draft.groups, next],
      members: draft.members.map((member) => {
        if (memberEmails.includes(member.email)) return { ...member, group_id: next.id };
        if (member.group_id === next.id) return { ...member, group_id: null };
        return member;
      }),
    });
    setEditing(null);
  };
  const deleteGroup = (id: string) => {
    if (!draft) return;
    update({
      groups: draft.groups.filter((group) => group.id !== id),
      members: draft.members.map((member) => (member.group_id === id ? { ...member, group_id: null } : member)),
    });
    setEditing(null);
  };
  const startNew = () => setEditing({
    id: newGroupId(), isNew: true, name: "", limitInput: "", unlimited: false, overrideInput: "",
    remaining: null, usedMonth: 0, memberCount: 0,
  });
  const updateTopup = (id: string, patch: Partial<DraftTopup>) => {
    if (!draft) return;
    update({ topups: draft.topups.map((topup) => (topup.id === id ? { ...topup, ...patch } : topup)) });
  };
  const addTopup = () => {
    if (!draft) return;
    update({ topups: [{ id: newGroupId(), day: todayLocal(), creditsInput: "", note: "" }, ...draft.topups] });
  };
  // 줄 단위 저장·삭제 — 이 줄이 반영된 충전 기록 전체를 바로 서버에 쓴다(그룹 초안은 안 보냄). 성공하면 revision·기록을 서버값으로.
  const saveTopups = async (rowId: string, nextTopups: DraftTopup[]) => {
    if (!draft || topupBusy) return;
    const invalid = nextTopups.map(validateTopup).find(Boolean);
    if (invalid) {
      setTopupError(invalid);
      return;
    }
    setTopupBusy(rowId);
    setTopupError("");
    try {
      const saved = await manageApi.saveCreditPlan(workspaceId, topupsOnlyBody(draft, nextTopups));
      onChange(mergeTopupsFromServer(draft, saved));
    } catch (reason) {
      setTopupError(isHttpStatus(reason, 409)
        ? "다른 곳에서 먼저 저장됐습니다. 설정 창을 닫았다가 다시 열어 주세요."
        : `저장하지 못했습니다. ${String(reason).replace(/^Error:\s*/, "")}`);
    } finally {
      setTopupBusy("");
    }
  };
  const unassigned = draft ? draft.members.filter((member) => member.is_available && !member.group_id).length : 0;

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
          {/* 월 충전은 위 '예산 한도(매월)'가 곧 그 값이라 여기선 다시 보여주지 않는다(Jay). 대시보드 풀 카드가 파생값을 보여 준다. */}
          <div className="credit-topup-editor">
            <div className="credit-plan-table-head">
              <span>긴급 충전 {draft.topups.length ? `· ${draft.topups.length}건` : ""}</span>
              <button type="button" className="credit-group-add" onClick={addTopup}>+ 추가</button>
            </div>
            {draft.topups.map((topup) => (
              <div className="credit-topup-row" key={topup.id}>
                <input type="date" value={topup.day} aria-label="충전 날짜" onChange={(event) => updateTopup(topup.id, { day: event.target.value })} />
                <input
                  className="settings-input"
                  type="text"
                  inputMode="numeric"
                  value={formatThousands(topup.creditsInput)}
                  placeholder="크레딧"
                  aria-label="충전 크레딧"
                  onChange={(event) => updateTopup(topup.id, { creditsInput: stripThousands(event.target.value) })}
                />
                <input className="settings-input" value={topup.note} placeholder="메모 (선택)" aria-label="메모" onChange={(event) => updateTopup(topup.id, { note: event.target.value })} />
                <button
                  type="button"
                  className="credit-topup-save"
                  disabled={topupBusy === topup.id}
                  title="이 줄을 바로 저장"
                  onClick={() => saveTopups(topup.id, draft.topups)}
                >
                  {topupBusy === topup.id ? "저장 중…" : "저장"}
                </button>
                <button
                  type="button"
                  className="credit-topup-remove"
                  disabled={topupBusy === topup.id}
                  title="이 기록을 바로 삭제"
                  onClick={() => {
                    if (!window.confirm(`${topup.day} 긴급 충전 기록을 삭제할까요?`)) return;
                    void saveTopups(topup.id, draft.topups.filter((item) => item.id !== topup.id));
                  }}
                >
                  삭제
                </button>
              </div>
            ))}
            {topupError ? <div className="login-error">{topupError}</div> : null}
          </div>
          <div className="credit-plan-table-head">
            <span>그룹 {draft.groups.length}{unassigned ? ` · 미배정 ${unassigned}명` : ""}</span>
            <button type="button" className="credit-group-add" onClick={startNew}>+ 그룹 추가</button>
          </div>
          {draft.groups.length ? (
            <table className="credit-plan-table">
              <thead><tr><th>그룹</th><th>월 한도</th><th>인원</th><th>지금 남은 양</th></tr></thead>
              <tbody>
                {draft.groups.map((group) => (
                  <tr key={group.id} onClick={() => setEditing(group)} title="클릭하면 그룹 창이 열립니다">
                    <td><b>{group.name}</b>{group.isNew ? <small> 저장 전</small> : null}</td>
                    <td>{group.unlimited ? "∞" : `${formatThousands(group.limitInput)} /월`}</td>
                    <td>{draftMemberCount(draft, group.id)}</td>
                    <td>{group.isNew ? "저장 후 계산" : n(group.remaining)}{group.overrideInput ? <small> 보정 예정</small> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="admin-empty">아직 그룹이 없습니다. "+ 그룹 추가"로 힉스필드 User Group 과 같은 이름을 만드세요.</div>
          )}
          {editing ? (
            <GroupEditor
              draft={draft}
              group={editing}
              onClose={() => setEditing(null)}
              onApply={applyGroup}
              onDelete={editing.isNew ? null : () => deleteGroup(editing.id)}
            />
          ) : null}
        </>
      ) : null}
    </section>
  );
}
