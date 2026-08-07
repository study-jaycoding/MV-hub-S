import { useMemo, useState } from "react";
import type {
  Member,
  Project,
  ProjectMember,
  WorkspaceMemberCandidate,
} from "../../types";
import { memberRoleRank, ProjectRolePicker } from "../admin/RolePickers";

type MemberCandidate = Member | WorkspaceMemberCandidate;

function candidateIsMine(candidate: MemberCandidate): boolean {
  return "is_mine" in candidate && Boolean(candidate.is_mine);
}

function candidateName(candidate: MemberCandidate): string {
  if (candidate.name) return candidate.name;
  if (candidateIsMine(candidate)) return "나";
  return candidate.email?.split("@")[0] || "팀원";
}

export function ProjectMembersPanel({
  project,
  projectMembers,
  candidates,
  systemUids,
  onClose,
  onRolesChange,
  onRemove,
  onAddMembers,
}: {
  project: Project;
  projectMembers: ProjectMember[] | undefined;
  candidates: MemberCandidate[] | undefined;
  systemUids: Set<string>;
  onClose: () => void;
  onRolesChange: (uid: string, roles: string[]) => Promise<void>;
  onRemove: (uid: string) => Promise<void>;
  onAddMembers: (uids: string[]) => Promise<void>;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState("");

  const visibleProjectMembers = useMemo(
    () => (projectMembers || []).filter((member) => !systemUids.has(member.uid)),
    [projectMembers, systemUids],
  );
  const candidateByUid = useMemo(
    () => new Map((candidates || []).map((candidate) => [candidate.uid, candidate])),
    [candidates],
  );
  const availableMembers = useMemo(() => {
    if (candidates === undefined) return undefined;
    const memberUids = new Set(visibleProjectMembers.map((member) => member.uid));
    const normalizedQuery = query.trim().toLowerCase();
    return candidates
      .filter((candidate) => !systemUids.has(candidate.uid) && !memberUids.has(candidate.uid))
      .filter((candidate) => {
        if (!normalizedQuery) return true;
        return [candidateName(candidate), candidate.email || "", candidate.uid]
          .some((value) => value.toLowerCase().includes(normalizedQuery));
      })
      .sort((left, right) => {
        const roleOrder = memberRoleRank(left.global_roles) - memberRoleRank(right.global_roles);
        if (roleOrder !== 0) return roleOrder;
        return candidateName(left).localeCompare(candidateName(right));
      });
  }, [candidates, query, systemUids, visibleProjectMembers]);

  const resetAddDialog = () => {
    setAddOpen(false);
    setQuery("");
    setSelected(new Set());
    setAddError("");
  };

  const closeAddDialog = () => {
    if (adding) return;
    resetAddDialog();
  };

  const toggleSelected = (uid: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });
    setAddError("");
  };

  const addSelectedMembers = async () => {
    if (adding || selected.size === 0) return;
    setAdding(true);
    setAddError("");
    try {
      await onAddMembers([...selected]);
      setAdding(false);
      resetAddDialog();
    } catch (reason) {
      setAddError(String(reason).replace(/^Error:\s*/, ""));
      setAdding(false);
    }
  };

  return (
    <aside className="project-members-panel" aria-label={`${project.name} 프로젝트 멤버`}>
      <header className="project-members-head">
        <div>
          <span className="project-members-icon">👥</span>
          <span>
            <strong>멤버</strong>
            <small>{project.name}</small>
          </span>
        </div>
        <button type="button" onClick={onClose} aria-label="멤버 패널 닫기">✕</button>
      </header>

      <button
        type="button"
        className="project-member-add-button"
        onClick={() => setAddOpen(true)}
      >
        + 추가
      </button>

      <div className="project-member-list">
        {projectMembers === undefined && <div className="admin-empty">멤버 불러오는 중…</div>}
        {projectMembers !== undefined && visibleProjectMembers.length === 0 && (
          <div className="project-member-empty">아직 프로젝트 멤버가 없습니다.</div>
        )}
        {visibleProjectMembers.map((member) => {
          const candidate = candidateByUid.get(member.uid);
          const name = member.name || (candidate ? candidateName(candidate) : member.uid);
          return (
            <article key={member.uid} className="project-member-card">
              <div className="project-member-identity">
                <span className="project-member-avatar">{name.slice(0, 1).toUpperCase()}</span>
                <span>
                  <strong>{name}</strong>
                  <small>{candidate?.email || member.uid}</small>
                </span>
                <button
                  type="button"
                  className="project-member-remove"
                  title="프로젝트에서 제거"
                  aria-label={`${name} 제거`}
                  onClick={() => void onRemove(member.uid)}
                >
                  ✕
                </button>
              </div>
              <ProjectRolePicker
                value={member.roles}
                onChange={(roles) => void onRolesChange(member.uid, roles)}
              />
            </article>
          );
        })}
      </div>

      {addOpen && (
        <div className="project-member-add-backdrop" onMouseDown={closeAddDialog}>
          <div
            className="project-member-add-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={`${project.name} 멤버 추가`}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className="project-member-add-close"
              onClick={closeAddDialog}
              disabled={adding}
              aria-label="멤버 추가 닫기"
            >
              ✕
            </button>
            <div className="project-member-add-symbol">👥</div>
            <h3>멤버 추가</h3>
            <p>{project.workspace_name || "전체 멤버"}에서 프로젝트 멤버를 선택하세요.</p>
            <label className="project-member-add-search">
              <span>⌕</span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="멤버 검색"
                autoFocus
              />
            </label>
            <div className="project-member-candidate-list">
              {availableMembers === undefined && <div className="admin-empty">멤버 불러오는 중…</div>}
              {availableMembers?.length === 0 && (
                <div className="admin-empty">{query ? "검색 결과가 없습니다." : "추가할 멤버가 없습니다."}</div>
              )}
              {availableMembers?.map((candidate) => {
                const name = candidateName(candidate);
                const isSelected = selected.has(candidate.uid);
                return (
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={isSelected}
                    key={candidate.uid}
                    className={`project-member-candidate${isSelected ? " on" : ""}`}
                    onClick={() => toggleSelected(candidate.uid)}
                  >
                    <span className="project-member-avatar">{name.slice(0, 1).toUpperCase()}</span>
                    <span>
                      <strong>{name}</strong>
                      <small>{candidate.email || candidate.uid}</small>
                    </span>
                    <i>{isSelected ? "✓" : ""}</i>
                  </button>
                );
              })}
            </div>
            {addError && <div className="login-error">{addError}</div>}
            <button
              type="button"
              className="project-member-add-confirm"
              onClick={() => void addSelectedMembers()}
              disabled={adding || selected.size === 0}
            >
              {adding ? "추가 중…" : `선택 ${selected.size}명 추가`}
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}
