// PM 대시보드 '관리 표' — 계정 한 줄에 등급·크레딧 그룹·프로젝트 참여·보고된 사실을 보고, 칸을 고치면 바로 저장한다.
// 설계: docs/MEMBER_TABLE_DESIGN.md. 표에는 자기만의 쓰기 API 가 없다 — 칸마다 기존 API 를 부른다(권한·감사·재기준화 그대로).
// 저장은 직렬 큐 하나로 줄 세우고, 큐가 비면 성공·실패와 관계없이 표를 다시 읽는다(다른 창·다른 사람의 변경은 큐 밖이다).
// 실패해도 칸을 하나씩 되돌리지 않는다 — 서버 값으로 통째로 다시 읽으므로 늦게 온 실패가 최신 값을 덮는 일이 없다.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api";
import type { CreditPlanSettings } from "../../lib/creditPlan";
import { isHttpStatus, isRouteMissing } from "../../lib/http";
import { manageApi } from "../../lib/manageApi";
import {
  applyProjectRoles,
  groupAssignBody,
  lastSeenLabel,
  matchesMemberQuery,
  type MemberTableData,
  type MemberTableRow,
} from "../../lib/memberTable";
import { createMutationQueue } from "../../lib/mutationQueue";
import { GLOBAL_ROLE_LABEL, PROJECT_ROLE_LABEL, PROJECT_ROLES } from "../../types";

const STATUS_LABEL: Record<string, string> = { approved: "승인", pending: "대기", rejected: "거절" };
const short = (label: string | undefined, fallback: string) => (label ? label.split(" · ")[0] : fallback);
const credits = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 2 });

export function MemberTable({ workspaceId = "", reloadSignal = 0 }: { workspaceId?: string; reloadSignal?: number }) {
  const [data, setData] = useState<MemberTableData | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [query, setQuery] = useState("");
  const creditRef = useRef<CreditPlanSettings | null>(null); // 그룹 저장에 쓰는 최신 원문(revision 포함)
  const requestRef = useRef(0);
  // 저장이 걸리거나 끝날 때마다 올린다 — 그 사이에 떠난 조회(reloadSignal 등)는 저장 전 값일 수 있어 버린다.
  // 안 버리면 낡은 revision 이 creditRef 를 덮어 다음 그룹 저장이 409 로 사라진다(코덱스 P1). 큐가 비면 어차피 다시 읽는다.
  const epochRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    const epoch = epochRef.current;
    const stale = () => requestRef.current !== requestId || epochRef.current !== epoch;
    try {
      const next = await manageApi.memberTable(workspaceId || undefined);
      if (stale()) return;
      creditRef.current = next.credit;
      setData(next);
      setError("");
    } catch (reason) {
      if (stale()) return;
      setData(null);
      setError(
        isRouteMissing(reason)
          ? "이 서버 버전은 관리 표를 지원하지 않습니다. 공유 서버 업데이트 뒤 표시됩니다."
          : isHttpStatus(reason, 403)
            ? "관리 표를 볼 권한이 없습니다(관리자·PM 전용)."
            : `관리 표를 불러오지 못했습니다. ${String(reason)}`,
      );
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load, reloadSignal]);

  const loadRef = useRef(load);
  loadRef.current = load;
  const queue = useMemo(
    () =>
      createMutationQueue(
        async (errors) => {
          const conflict = errors.some((reason) => isHttpStatus(reason, 409));
          setNotice({
            tone: "bad",
            text: conflict
              ? "다른 사람이 먼저 바꿨습니다. 최신 값으로 다시 읽었으니 한 번 더 고쳐 주세요."
              : `저장하지 못했습니다. ${String(errors[0])}`,
          });
          await loadRef.current();
        },
        () => loadRef.current(),
      ),
    [],
  );

  // 저장 한 건 — 걸 때와 끝날 때 epoch 를 올려 그 사이의 조회를 무효로 만든다.
  const save = (operation: () => Promise<void>) => {
    epochRef.current += 1;
    void queue.enqueue(async () => {
      try {
        await operation();
      } finally {
        epochRef.current += 1;
      }
    });
  };
  // 표가 지금 고른 워크스페이스의 것일 때만 고친다 — 전환 직후 이전 표로 새 워크스페이스에 저장하는 일을 막는다(코덱스 P0).
  const inScope = (data?.workspace_id ?? "") === workspaceId;

  const setGroup = (row: MemberTableRow, groupId: string | null) => {
    if (!data || !inScope || !workspaceId || groupId === row.group_id) return;
    const groupName = data.groups.find((group) => group.id === groupId)?.name ?? "그룹 없음";
    setData({ ...data, rows: data.rows.map((item) => (item.email === row.email ? { ...item, group_id: groupId } : item)) });
    save(async () => {
      const credit = creditRef.current;
      if (!credit) throw new Error("그룹 설정을 읽지 못했습니다");
      creditRef.current = await manageApi.saveCreditPlan(workspaceId, groupAssignBody(credit, row.email, groupId));
      setNotice({ tone: "ok", text: `저장됨 · 그룹 (${row.name} → ${groupName})` });
    });
  };

  const toggleRole = (row: MemberTableRow, project: { id: string; name: string }, role: string) => {
    const uid = row.uid;
    if (!data || !inScope || !uid) return;
    const current = row.projects[project.id] || [];
    const roles = current.includes(role) ? current.filter((item) => item !== role) : [...current, role];
    // 마지막 역할을 빼면 프로젝트에서 제거 — 제거 기록이 남아 워크스페이스 자동 편입이 되살리지 못한다.
    if (!roles.length && !window.confirm(`${row.name} 님을 '${project.name}' 에서 뺄까요?\n자동 편입으로는 다시 들어오지 않습니다(역할을 다시 주면 돌아옵니다).`)) return;
    setData({ ...data, rows: applyProjectRoles(data.rows, uid, project.id, roles) });
    save(async () => {
      if (roles.length) await api.setProjectRoles(project.id, uid, roles);
      else await api.removeProjectMember(project.id, uid);
      setNotice({ tone: "ok", text: `저장됨 · ${project.name} (${row.name})` });
    });
  };

  if (error) return <div className="usage-error">{error}</div>;
  if (!data) return <div className="usage-loading">관리 표를 불러오는 중…</div>;

  const groupById = new Map(data.groups.map((group) => [group.id, group]));
  const rows = data.rows.filter((row) => matchesMemberQuery(row, query));
  const canGroup = data.caps.credit && Boolean(data.credit);
  const lock = (can: boolean, why: string) => (can ? undefined : why);

  return (
    <div className="mtable">
      <div className="mtable-bar">
        <b>관리 표</b>
        <span className="mtable-hint">칸을 고치면 바로 적용됩니다</span>
        <span className="mtable-gap" />
        {notice ? <span className={"mtable-notice " + notice.tone} role="status">{notice.tone === "ok" ? "✓ " : "⚠ "}{notice.text}</span> : null}
        <div className="work-search">
          <span className="work-search-ic">🔍</span>
          <input value={query} placeholder="이름·이메일 검색" onChange={(event) => setQuery(event.target.value)} />
        </div>
      </div>
      {!data.workspace_id ? (
        <div className="mtable-note">워크스페이스를 고르면 크레딧 그룹과 이번 충전 달 사용량이 함께 보입니다.</div>
      ) : null}
      <div className="mtable-scroll">
        <table>
          <thead>
            <tr className="mtable-groups">
              <th colSpan={2}>사람</th>
              <th colSpan={2} title="서버 보호(마지막 관리자)를 넣은 뒤 편집을 엽니다 — 지금은 보기만">계정 · 보기만</th>
              {data.workspace_id ? <th colSpan={2}>크레딧 그룹</th> : null}
              {data.projects.length ? <th colSpan={data.projects.length}>프로젝트 참여</th> : null}
              <th colSpan={data.workspace_id ? 4 : 2}>보고된 사실</th>
            </tr>
            <tr>
              <th className="mtable-sticky">이름</th>
              <th>이메일</th>
              <th className="ro">가입</th>
              <th className="ro">등급</th>
              {data.workspace_id ? <th className={canGroup ? "ed" : "ro"} title={lock(canGroup, "PM(프로젝트 생성 권한)만 바꿀 수 있습니다")}>그룹</th> : null}
              {data.workspace_id ? <th className="ro">남은 양 / 한도</th> : null}
              {data.projects.map((project) => (
                <th key={project.id} className={data.caps.project_roles ? "ed" : "ro"} title={lock(data.caps.project_roles, "PM(멤버 역할 부여 권한)만 바꿀 수 있습니다")}>
                  {project.name}
                </th>
              ))}
              <th className="ro">HF 플랜</th>
              <th className="ro">마지막 보고</th>
              {data.workspace_id ? <th className="ro num">이번 충전 달 크레딧</th> : null}
              {data.workspace_id ? <th className="ro num">생성 수</th> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const group = row.group_id ? groupById.get(row.group_id) : undefined;
              return (
                <tr key={row.email}>
                  <td className="mtable-sticky mtable-name">{row.name}</td>
                  <td>{row.email}</td>
                  <td className={"ro status-" + (row.status || "none")}>{row.status ? STATUS_LABEL[row.status] || row.status : "계정 없음"}</td>
                  <td className="ro">
                    {row.global_roles.map((role) => (
                      <span key={role} className={"mtable-chip role-" + role}>{short(GLOBAL_ROLE_LABEL[role], role)}</span>
                    ))}
                  </td>
                  {data.workspace_id ? (
                    <td className={canGroup ? "" : "ro"}>
                      {canGroup ? (
                        <select
                          aria-label={`${row.name} 크레딧 그룹`}
                          value={row.group_id ?? ""}
                          onChange={(event) => setGroup(row, event.target.value || null)}
                        >
                          <option value="">그룹 없음</option>
                          {data.groups.map((item) => (
                            <option key={item.id} value={item.id}>{item.name}</option>
                          ))}
                        </select>
                      ) : (
                        group?.name ?? "그룹 없음"
                      )}
                    </td>
                  ) : null}
                  {data.workspace_id ? (
                    <td className="ro num">
                      {!group ? "—" : group.monthly_limit === null ? "제한 없음" : `${credits(group.remaining ?? 0)} / ${credits(group.monthly_limit)}`}
                    </td>
                  ) : null}
                  {!row.project_editable && data.projects.length ? (
                    <td className="mtable-off" colSpan={data.projects.length}>
                      {row.project_lock === "uid_conflict"
                        ? "계정과 워크스페이스 보고의 작성자 정보가 서로 달라 여기서는 바꿀 수 없습니다"
                        : "에이전트가 아직 연결되지 않아 프로젝트에 넣을 수 없습니다"}
                    </td>
                  ) : (
                    data.projects.map((project) => {
                      const roles = row.projects[project.id] || [];
                      return (
                        <td key={project.id} className={data.caps.project_roles ? "" : "ro"}>
                          {PROJECT_ROLES.map((role) => {
                            const on = roles.includes(role);
                            if (!data.caps.project_roles) return on ? <span key={role} className={"mtable-chip role-" + role}>{short(PROJECT_ROLE_LABEL[role], role)}</span> : null;
                            return (
                              <button
                                key={role}
                                type="button"
                                className={"mtable-chip role-" + role + (on ? "" : " off")}
                                aria-pressed={on}
                                title={PROJECT_ROLE_LABEL[role] + (row.linked_accounts > 1 ? ` — 같은 사람의 계정 ${row.linked_accounts}개에 함께 적용됩니다` : "")}
                                onClick={() => toggleRole(row, project, role)}
                              >
                                {short(PROJECT_ROLE_LABEL[role], role)}
                              </button>
                            );
                          })}
                        </td>
                      );
                    })
                  )}
                  <td className="ro">{row.hf_plan || "—"}</td>
                  <td className={"ro" + (row.is_available === false ? " mtable-dim" : "")}>
                    {row.is_available === false ? "워크스페이스에서 안 보임" : lastSeenLabel(row.last_seen_at)}
                  </td>
                  {data.workspace_id ? <td className="ro num">{row.usage ? credits(row.usage.credits) : "—"}</td> : null}
                  {data.workspace_id ? <td className="ro num">{row.usage ? row.usage.count.toLocaleString() : "—"}</td> : null}
                </tr>
              );
            })}
            {!rows.length ? (
              <tr><td className="mtable-empty" colSpan={99}>{query ? "검색 결과가 없습니다." : "표시할 멤버가 없습니다."}</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <div className="mtable-sheets">
        <span className="on">멤버 {data.rows.length}</span>
        <span title="다음 단계에서 열립니다 — 지금은 프로젝트 설정 창에서 고칩니다">그룹 {data.groups.length}</span>
        <span title="다음 단계에서 열립니다 — 지금은 프로젝트 설정 창에서 고칩니다">충전 기록 {data.credit ? data.credit.topups.length : "·"}</span>
      </div>
    </div>
  );
}
