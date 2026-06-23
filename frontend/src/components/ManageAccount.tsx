// 내 계정 관리 — AccountMenu의 "Manage Account"로 열린다.
// 계정 정보(이메일·등급·플랜·크레딧) 표시 + 표시이름 변경(여기서 직접 수정).
import { useEffect, useState } from "react";
import { api } from "../api";
import { GLOBAL_ROLE_LABEL } from "../types";
import type { Account } from "../types";

type Provider = { uid: string | null; name: string | null; email: string | null };

export function ManageAccount({
  provider,
  account,
  onClose,
}: {
  provider: Provider | null;
  account?: Account | null;
  onClose: () => void;
  onProviderUpdated: (p: Provider) => void; // (유지 — 호출 안 함; 표시이름은 계정별 account.name 기준)
}) {
  // 표시이름은 계정별(account.name) — 전역 provider 가 아니다. 없으면 이메일 로컬파트로.
  const initialName =
    account?.name || (account?.email ? account.email.split("@")[0] : "") || "";
  const [name, setName] = useState(initialName);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [curPw, setCurPw] = useState("");
  const [pw, setPw] = useState("");
  const [pwSaving, setPwSaving] = useState(false);
  const [pwMsg, setPwMsg] = useState("");
  const [acct, setAcct] = useState<{
    credits: number | null;
    plan: string;
    email: string;
  } | null>(null);

  useEffect(() => {
    api.account().then(setAcct).catch(() => {});
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = async () => {
    const n = name.trim();
    if (!n || n === (account?.name || "")) return;
    setSaving(true);
    setMsg("");
    try {
      await api.setMyName(n); // 계정별 account.name 변경(+creator.name 미러)
      window.dispatchEvent(new CustomEvent("ch:account-updated")); // App 이 account 재조회
      setMsg("저장되었습니다.");
    } catch (e) {
      setMsg("변경 실패: " + String(e));
    } finally {
      setSaving(false);
    }
  };

  const changePw = async () => {
    if (!curPw) {
      setPwMsg("현재 비밀번호를 입력하세요.");
      return;
    }
    if (pw.trim().length < 6) {
      setPwMsg("새 비밀번호는 6자 이상이어야 합니다.");
      return;
    }
    setPwSaving(true);
    setPwMsg("");
    try {
      await api.setMyPassword(curPw, pw.trim());
      setCurPw("");
      setPw("");
      setPwMsg("비밀번호가 변경되었습니다.");
    } catch (e) {
      setPwMsg("변경 실패: " + String(e).replace(/^Error:\s*\d+:\s*/, ""));
    } finally {
      setPwSaving(false);
    }
  };

  const email = account?.email || provider?.email || acct?.email || "—";

  return (
    <>
      {/* 전체를 가리지 않는 투명 클릭 캐처(바깥 클릭 시 닫힘) — 모달 아닌 플로팅 */}
      <div className="info-catcher" onMouseDown={onClose} />
      <div className="manage-float" role="dialog" aria-label="내 계정">
        <header className="admin-head">
          <span className="admin-title">⚙ 내 계정</span>
          <button className="assets-x" onClick={onClose} title="닫기">
            ✕
          </button>
        </header>

        <div className="admin-body">
          {/* 표시이름 — 공유 파일명·작성자 표기 기준(uid 앵커는 불변) */}
          <section className="manage-field">
            <label>표시이름</label>
            <div className="manage-name-row">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="표시이름"
                onKeyDown={(e) => e.key === "Enter" && save()}
              />
              <button
                className="manage-save"
                onClick={save}
                disabled={saving || !name.trim() || name.trim() === (account?.name || "")}
              >
                {saving ? "저장 중…" : "저장"}
              </button>
            </div>
            <p className="manage-hint">
              공유 파일명·작성자 표기에 쓰입니다. 내부 식별자(uid)는 바뀌지 않아 기존 공유와의
              연결이 깨지지 않습니다.
            </p>
            {msg && <p className="manage-msg">{msg}</p>}
          </section>

          {/* 비밀번호 변경 — 허브 로그인 + 에이전트 실행에 함께 쓰는 비번 */}
          <section className="manage-field" style={{ marginTop: 18 }}>
            <label>비밀번호 변경</label>
            <div className="manage-name-row" style={{ marginBottom: 8 }}>
              <input
                type="password"
                value={curPw}
                onChange={(e) => setCurPw(e.target.value)}
                placeholder="현재 비밀번호"
              />
              {/* 표시이름 칸과 입력 폭을 맞추기 위한 숨김 버튼(자리만 차지) */}
              <button
                className="manage-save"
                style={{ visibility: "hidden" }}
                tabIndex={-1}
                aria-hidden
              >
                변경
              </button>
            </div>
            <div className="manage-name-row">
              <input
                type="password"
                value={pw}
                onChange={(e) => setPw(e.target.value)}
                placeholder="새 비밀번호 (6자 이상)"
                onKeyDown={(e) => e.key === "Enter" && changePw()}
              />
              <button
                className="manage-save"
                onClick={changePw}
                disabled={pwSaving || !curPw || pw.trim().length < 6}
              >
                {pwSaving ? "변경 중…" : "변경"}
              </button>
            </div>
            <p className="manage-hint">
              이 비밀번호는 허브 로그인과 에이전트(MV_agent.bat) 실행에 함께 쓰입니다.
            </p>
            {pwMsg && <p className="manage-msg">{pwMsg}</p>}
          </section>

          {/* 계정 정보 */}
          <section className="manage-info">
            <Row label="이메일" value={email} />
            {account?.global_roles && account.global_roles.length > 0 && (
              <Row
                label="전역 역할"
                value={account.global_roles
                  .map((r) => (GLOBAL_ROLE_LABEL[r] || r).split(" · ")[0])
                  .join(", ")}
              />
            )}
            {account && <Row label="로그인 상태" value={account.status} />}
            <Row label="플랜" value={acct?.plan || "—"} />
            <Row
              label="크레딧"
              value={
                acct?.credits != null
                  ? `${Math.round(acct.credits).toLocaleString()} 남음`
                  : "조회 중…"
              }
            />
            <Row label="계정 식별자" value={account?.creator_uid || provider?.uid || "—"} mono />
          </section>
        </div>
      </div>
    </>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="manage-row">
      <span className="manage-row-label">{label}</span>
      <span className={"manage-row-value" + (mono ? " mono" : "")}>{value}</span>
    </div>
  );
}
