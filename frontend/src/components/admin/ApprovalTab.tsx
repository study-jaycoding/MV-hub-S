import type { Account } from "../../types";

export type AdminConfirmState =
  | { kind: "reset" | "hide" | "unhide"; email: string; name: string }
  | null;

export function ApprovalTab({
  accounts,
  showHidden,
  setShowHidden,
  actMsg,
  confirm,
  setConfirm,
  runConfirm,
  approve,
}: {
  accounts: Account[];
  showHidden: boolean;
  setShowHidden: (show: boolean) => void;
  actMsg: string;
  confirm: AdminConfirmState;
  setConfirm: (confirm: AdminConfirmState) => void;
  runConfirm: () => void;
  approve: (account: Account, status: string) => void;
}) {
  return (
    <section className="admin-section">
      <div className="admin-note-sub">
        가입 신청을 승인/거부하고 로그인 계정의 전역 역할을 부여합니다(Admin 전용).
      </div>
      <h4>승인 절차</h4>
      <label className="admin-hidden-toggle">
        <input
          type="checkbox"
          checked={showHidden}
          onChange={(e) => setShowHidden(e.target.checked)}
        />
        숨긴 계정 보기
      </label>
      {actMsg && <div className="admin-act-msg">{actMsg}</div>}
      {accounts.length === 0 && <div className="admin-empty">계정 없음</div>}
      <table className="admin-table">
        <thead>
          <tr>
            <th>계정</th>
            <th className="th-center">상태 (클릭하여 변경)</th>
            <th className="th-right">관리</th>
          </tr>
        </thead>
        <tbody>
          {accounts.map((account) => (
            <tr key={account.email} className={account.hidden ? "admin-row-hidden" : ""}>
              <td>
                <div className="admin-member">
                  <span className="admin-mname">{account.name || account.email}</span>
                  <span className="admin-muid" title={account.email}>
                    {account.email}
                  </span>
                </div>
              </td>
              <td className="td-center">
                <div className="acct-status-seg">
                  {(
                    [
                      ["approved", "승인"],
                      ["pending", "대기"],
                      ["rejected", "차단"],
                    ] as const
                  ).map(([status, label]) => (
                    <button
                      key={status}
                      className={
                        "acct-seg acct-seg-" +
                        status +
                        (account.status === status ? " on" : "")
                      }
                      onClick={() => account.status !== status && approve(account, status)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </td>
              <td className="td-right">
                <div className="admin-acct-actions">
                  <button
                    className="admin-mini-btn"
                    onClick={() =>
                      setConfirm({
                        kind: "reset",
                        email: account.email,
                        name: account.name || account.email,
                      })
                    }
                  >
                    비밀번호 초기화
                  </button>
                  <button
                    className="admin-mini-btn"
                    onClick={() =>
                      setConfirm({
                        kind: account.hidden ? "unhide" : "hide",
                        email: account.email,
                        name: account.name || account.email,
                      })
                    }
                  >
                    {account.hidden ? "숨김 해제" : "숨기기"}
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="admin-note-sub">
        전역 역할은 <b>멤버 · 전역 역할</b> 탭에서 부여합니다.
      </div>

      {confirm && (
        <div className="admin-confirm-backdrop" onMouseDown={() => setConfirm(null)}>
          <div className="admin-confirm" onMouseDown={(e) => e.stopPropagation()}>
            <p className="admin-confirm-q">
              {confirm.kind === "reset"
                ? `${confirm.name} 비밀번호를 111111 로 정말 초기화하시겠습니까?`
                : confirm.kind === "hide"
                  ? `${confirm.name} 계정을 정말 숨기시겠습니까?`
                  : `${confirm.name} 숨김을 해제하시겠습니까?`}
            </p>
            <div className="admin-confirm-actions">
              <button className="admin-confirm-yes" onClick={runConfirm}>
                예
              </button>
              <button className="admin-confirm-no" onClick={() => setConfirm(null)}>
                아니오
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
