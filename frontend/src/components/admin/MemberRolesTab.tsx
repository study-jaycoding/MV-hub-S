import type { Member } from "../../types";
import { AdminIcon, AdminPageHead, AdminPerson } from "./AdminParts";
import { GlobalRolePicker } from "./RolePickers";

export function MemberRolesTab({
  members,
  memberQuery,
  setMemberQuery,
  shortUid,
  onChangeRoles,
  busy,
}: {
  members: Member[];
  memberQuery: string;
  setMemberQuery: (query: string) => void;
  shortUid: (uid: string) => string;
  onChangeRoles: (uid: string, roles: string[]) => void;
  // 역할 저장이 도는 중 — 누구의 것이든 모든 줄의 칩을 잠근다(저장은 한 줄로 선다 — AdminWindow 의 주석).
  busy: boolean;
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
      <AdminPageHead
        title="멤버"
        desc="전역 역할은 사람 단위 권한이고, 한 사람이 여러 개를 가질 수 있습니다. 프로젝트 안 역할은 프로젝트에서 줍니다."
      >
        <div className="proj-add-search member-search">
          <span className="proj-add-search-icn"><AdminIcon name="search" size={15} /></span>
          <input
            value={memberQuery}
            onChange={(e) => setMemberQuery(e.target.value)}
            placeholder="멤버 검색"
          />
        </div>
      </AdminPageHead>
      <table className="admin-table">
        <thead>
          <tr>
            <th>멤버</th>
            <th className="admin-num">생성물</th>
            <th>전역 역할</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((member) => (
            <tr key={member.uid}>
              <td>
                <AdminPerson
                  name={member.is_mine ? "나" : member.name || "팀원"}
                  sub={member.email || shortUid(member.uid)}
                  subTitle={member.uid}
                  mine={member.is_mine}
                />
              </td>
              <td className="admin-count admin-num">{member.count?.toLocaleString()}</td>
              <td>
                <GlobalRolePicker
                  value={member.global_roles}
                  onChange={(roles) => onChangeRoles(member.uid, roles)}
                  disabled={busy}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
