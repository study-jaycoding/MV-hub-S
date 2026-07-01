import type { Member } from "../../types";
import { GlobalRolePicker } from "./RolePickers";

export function MemberRolesTab({
  members,
  memberQuery,
  setMemberQuery,
  shortUid,
  onChangeRoles,
}: {
  members: Member[];
  memberQuery: string;
  setMemberQuery: (query: string) => void;
  shortUid: (uid: string) => string;
  onChangeRoles: (uid: string, roles: string[]) => void;
}) {
  const query = memberQuery.trim().toLowerCase();
  const filtered = members.filter((member) => {
    if (!query) return true;
    const name = (member.is_mine ? "나" : member.name || "팀원").toLowerCase();
    return (
      name.includes(query) ||
      member.uid.toLowerCase().includes(query) ||
      (member.email || "").toLowerCase().includes(query)
    );
  });

  return (
    <section className="admin-section">
      <h4>멤버 · 전역 역할 설정</h4>
      <div className="admin-note-sub">
        전역 역할은 사람 단위 권한입니다(복수 가능). 프로젝트 안 역할(작업·검수)은
        프로젝트 탭에서 부여하세요.
      </div>
      <div className="proj-add-search member-search">
        <span className="proj-add-search-icn">🔍</span>
        <input
          value={memberQuery}
          onChange={(e) => setMemberQuery(e.target.value)}
          placeholder="멤버 검색"
        />
      </div>
      <table className="admin-table">
        <thead>
          <tr>
            <th>멤버</th>
            <th>생성물</th>
            <th>전역 역할</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((member) => (
            <tr key={member.uid}>
              <td>
                <div className="admin-member">
                  <span className={"admin-dot" + (member.is_mine ? " mine" : "")} />
                  <span className="admin-mname">
                    {member.is_mine ? "나" : member.name || "팀원"}
                  </span>
                  <span className="admin-muid" title={member.uid}>
                    {member.email || shortUid(member.uid)}
                  </span>
                </div>
              </td>
              <td className="admin-count">{member.count}</td>
              <td>
                <GlobalRolePicker
                  value={member.global_roles}
                  onChange={(roles) => onChangeRoles(member.uid, roles)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
