// 프로젝트 설정 창의 '크레딧 풀 · 그룹' 절 — 워크스페이스 단위 설정(월 충전·그룹 월 한도·멤버 배정).
// 힉스필드 관리 창(User Group)과 같은 흐름: 그룹 표 + "그룹 추가" → 그룹 창(이름·한도 없음 토글·월 한도·남은 양 보정 |
// 멤버 목록·멤버 추가). 저장은 ProjectManagerPanel 이 프로젝트 저장 뒤 별도 PUT 으로(revision 낙관적 잠금 — 409).
// 초안 상태는 부모(다이얼로그 state)가 들고, 여기서는 초안만 바꾼다. 숫자 칸은 천 단위 구분으로 보여 준다.
import { useEffect, useState } from "react";
import { isHttpStatus, isRouteMissing } from "../../lib/http";
import { manageApi } from "../../lib/manageApi";
import { useModelDisplayName } from "../../lib/modelCatalog";
import { BUDGET_PERIOD_OPTIONS } from "../../lib/projectPlanning";
import { ALLOWED } from "../../lib/useModels";
import { formatCredits } from "../../lib/formatCredits";
import {
  draftFromSettings,
  draftMemberCount,
  formatThousands,
  mergeTopupsFromServer,
  newGroupId,
  periodSuffix,
  stripThousands,
  todayLocal,
  topupsOnlyBody,
  validateTopup,
  type CreditPlanDraft,
  type CreditPlanMember,
  type DraftGroup,
  type DraftTopup,
  type LimitPeriod,
} from "../../lib/creditPlan";

function n(value: number | null): string {
  return formatCredits(value, "∞");
}

function memberLabel(member: CreditPlanMember): string {
  return member.name || member.email.split("@")[0];
}

// 그룹 창의 '사용 모델' 후보 — 앱이 생성 창에 실제로 보여 주는 모델만(이미지·영상, Jay 2026-09-11: 부분 수정 모델은 제외).
// 저장값은 job_type 문자열이라 여기 없는 옛·미래 id 도 알약으로는 보여 주고 그대로 보존한다.
const SELECTABLE_MODEL_GROUPS: { title: string; ids: readonly string[] }[] = [
  { title: "이미지", ids: ALLOWED.image },
  { title: "영상", ids: ALLOWED.video },
];

// ── 그룹 창(힉스필드 "Add new group" 과 같은 두 칸 구성) ──────────────────────
function GroupEditor({
  draft,
  group,
  onClose,
  onApply,
}: {
  draft: CreditPlanDraft;
  group: DraftGroup; // 새 그룹이면 isNew=true 로 미리 만든 것
  onClose: () => void;
  onApply: (next: DraftGroup, memberEmails: string[]) => void;
}) {
  const [name, setName] = useState(group.name);
  const [unlimited, setUnlimited] = useState(group.unlimited);
  const [limitInput, setLimitInput] = useState(group.limitInput);
  const [limitPeriod, setLimitPeriod] = useState<LimitPeriod>(group.limitPeriod);
  // 사용 모델(**허용 목록** — 체크한 것만 쓴다, 아무것도 없으면 제한 없음). 저장해야 서버에 간다.
  const [allowed, setAllowed] = useState<string[]>(group.allowedModels);
  const [pickingModels, setPickingModels] = useState(false);
  const modelLabel = useModelDisplayName();
  const toggleAllowed = (id: string) =>
    setAllowed((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
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
      { ...group, name: trimmed, unlimited, limitInput: stripThousands(limitInput), limitPeriod, allowedModels: allowed },
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
              <span>한도</span>
              <div className="manage-budget-limit">
                <input
                  type="text"
                  inputMode="numeric"
                  value={formatThousands(limitInput)}
                  placeholder="예: 5,000"
                  onChange={(event) => { setLimitInput(stripThousands(event.target.value)); setError(""); }}
                />
                <em>크레딧</em>
                <select
                  value={limitPeriod}
                  aria-label="한도 주기"
                  title="매월만 남은 양이 다음 달로 넘어갑니다(힉스필드 enterprise). 매일·매주는 그 기간 안에서만 셉니다."
                  onChange={(event) => setLimitPeriod(event.target.value as LimitPeriod)}
                >
                  {BUDGET_PERIOD_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </div>
            </label>
          ) : null}
          <div className="credit-modal-field credit-allow">
            <div className="credit-allow-head">
              <span>사용 모델</span>
              <button
                type="button"
                className={"credit-pill" + (pickingModels ? " solid" : "")}
                onClick={() => setPickingModels((current) => !current)}
              >
                {pickingModels ? "완료" : "+ 고르기"}
              </button>
            </div>
            {allowed.length ? (
              <>
                <div className="credit-allow-chips">
                  {allowed.map((id) => (
                    <span className="credit-chip" key={id} title={id}>
                      {modelLabel(id)}
                      <button type="button" aria-label={`${modelLabel(id)} 빼기`} onClick={() => toggleAllowed(id)}>×</button>
                    </span>
                  ))}
                </div>
                <small className="credit-allow-empty">이 {allowed.length}개만 쓸 수 있습니다 — 나머지는 멤버의 생성 창·캔버스 모델 선택 목록에서 빠집니다.</small>
              </>
            ) : (
              <small className="credit-allow-empty">제한 없음 — 이 그룹 멤버는 모든 모델을 씁니다. 특정 모델만 쓰게 하려면 아래에서 체크하세요.</small>
            )}
            {pickingModels ? (
              <div className="credit-allow-pick" role="group" aria-label="쓸 수 있는 모델 고르기">
                {SELECTABLE_MODEL_GROUPS.map((section) => (
                  <div key={section.title}>
                    <div className="credit-allow-group">{section.title}</div>
                    {section.ids.map((id) => (
                      <label className="credit-allow-row" key={id}>
                        <span>{modelLabel(id)}</span>
                        <input type="checkbox" checked={allowed.includes(id)} onChange={() => toggleAllowed(id)} />
                      </label>
                    ))}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
          {error ? <div className="login-error">{error}</div> : null}
          {/* 삭제는 그룹 표의 휴지통에서 한다(Jay 2026-09-11) — 편집 창에서는 저장·닫기만. */}
          <div className="credit-modal-actions">
            <button type="button" className="admin-confirm-yes" onClick={save}>저장</button>
            <button type="button" className="credit-modal-delete" onClick={onClose}>닫기</button>
          </div>
        </div>
        <div className="credit-modal-right">
          {/* 머리줄 = [멤버 N] … [+ 멤버 추가] [×] — 닫기 X 를 줄 안에 넣어 아래 멤버들의 × 와 세로로 맞춘다(Jay). */}
          <div className="credit-modal-members-head">
            <span>멤버 {assigned.length}</span>
            <div className="credit-modal-head-right">
              {!picking && candidates.length ? (
                <button type="button" className="credit-pill" onClick={() => setPicking(true)}>+ 멤버 추가</button>
              ) : null}
              <button type="button" className="credit-modal-close" aria-label="닫기" onClick={onClose}>×</button>
            </div>
          </div>
          {picking ? (
            <div className="credit-pick">
              <div className="credit-pick-head">
                <span>추가할 멤버를 고르세요 — 다른 그룹에 있으면 옮겨집니다</span>
                <button type="button" className="credit-pill" onClick={() => setPicking(false)}>완료</button>
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
              {candidates.length ? <button type="button" className="credit-pill solid" onClick={() => setPicking(true)}>멤버 추가</button> : null}
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
  // 그룹 삭제 확인 — 브라우저 기본 창 대신 우리 디자인 확인창(이름을 보여 주고 묻는다).
  const [deleting, setDeleting] = useState<DraftGroup | null>(null);
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
    id: newGroupId(), isNew: true, name: "", limitInput: "", limitPeriod: "month", unlimited: false,
    remaining: null, usedMonth: 0, memberCount: 0, allowedModels: [],
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
          <label className="manage-field">
            <span>충전 기준일</span>
            <div className="manage-budget-limit credit-topup-day">
              <em>매월</em>
              <select
                value={draft.topupDay}
                aria-label="매월 충전 기준일"
                title="힉스필드가 이 워크스페이스에 크레딧을 넣는 날 — 이날부터 다음 달 전날까지를 '이번 달'로 셉니다(예산 한도·그룹 이월·풀 카드 공통)"
                onChange={(event) => update({ topupDay: Number(event.target.value) })}
              >
                {Array.from({ length: 28 }, (_, index) => index + 1).map((day) => (
                  <option key={day} value={day}>{day}일</option>
                ))}
              </select>
            </div>
          </label>
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
              <thead><tr><th>그룹</th><th>한도</th><th>인원</th><th title="이월 포함 · 힉스필드 값과 다르면 대시보드 그룹 표의 '추정'에서 맞춥니다">지금 남은 양</th><th aria-label="삭제" /></tr></thead>
              <tbody>
                {draft.groups.map((group) => (
                  <tr key={group.id} onClick={() => setEditing(group)} title="클릭하면 그룹 창이 열립니다">
                    <td>
                      <b>{group.name}</b>{group.isNew ? <small> 저장 전</small> : null}
                      {group.allowedModels.length ? (
                        <small className="credit-allow-badge" title={group.allowedModels.join(", ")}> · 모델 {group.allowedModels.length}개만</small>
                      ) : null}
                    </td>
                    <td>{group.unlimited ? "∞" : `${formatThousands(group.limitInput)} ${periodSuffix(group.limitPeriod)}`}</td>
                    <td>{draftMemberCount(draft, group.id)}</td>
                    <td>{group.isNew ? "저장 후 계산" : n(group.remaining)}</td>
                    <td className="credit-plan-del-cell">
                      <button
                        type="button"
                        className="credit-plan-del"
                        aria-label={`${group.name} 그룹 삭제`}
                        title="이 그룹 삭제"
                        onClick={(event) => {
                          event.stopPropagation(); // 줄 클릭(그룹 창 열기)과 겹치지 않게
                          setDeleting(group);
                        }}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M3 6h18" />
                          <path d="M8 6V4h8v2" />
                          <path d="M19 6l-1 14H6L5 6" />
                          <path d="M10 11v6M14 11v6" />
                        </svg>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          {editing ? (
            <GroupEditor
              draft={draft}
              group={editing}
              onClose={() => setEditing(null)}
              onApply={applyGroup}
            />
          ) : null}
          {deleting ? (
            <div className="admin-confirm-backdrop" onMouseDown={() => setDeleting(null)}>
              <div className="admin-confirm" onMouseDown={(event) => event.stopPropagation()}>
                <p className="admin-confirm-q">
                  <b>{deleting.name}</b> 그룹을 삭제하시겠습니까?
                  <br />
                  <small>이 그룹에 배정된 멤버 {draftMemberCount(draft, deleting.id)}명의 배정도 함께 풀립니다.</small>
                </p>
                <div className="admin-confirm-actions">
                  <button
                    type="button"
                    className="admin-confirm-yes"
                    onClick={() => {
                      deleteGroup(deleting.id);
                      setDeleting(null);
                    }}
                  >
                    삭제
                  </button>
                  <button type="button" className="admin-confirm-no" onClick={() => setDeleting(null)}>
                    취소
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
