// 로그인 화면 — CONTENT_HUB_AUTH=1 이고 미로그인일 때 앱 전체를 가린다.
// 로그인=가입 통합: 힉스필드 이메일 + 비밀번호 하나로. 처음 보는 이메일이면 자동 등록(관리자 승인 대기),
// 승인되면 같은 이메일·비번으로 입장. 별도 '가입' 단계·'허브 아이디 생성'은 없다(계정=힉스필드 이메일).
// 첫 계정만 부트스트랩 관리자라 바로 로그인된다. 신원 확정은 에이전트의 CLI 이메일 일치 검증이 한다.
import { useState } from "react";
import { api, setAuthToken } from "../api";
import type { Account, AuthConfig } from "../types";

export function LoginScreen({
  config,
  onAuthed,
}: {
  config: AuthConfig;
  onAuthed: (account: Account) => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  const first = !config.has_accounts; // 첫 계정 = 관리자 부트스트랩

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setInfo("");
    setBusy(true);
    try {
      const { account, token, pending } = await api.access(email.trim(), password);
      if (token) {
        setAuthToken(token); // 승인됨(또는 첫 계정=관리자) → 입장
        onAuthed(account);
      } else {
        // 처음 보는 이메일이면 방금 자동 등록됨 / 이미 있으면 승인 대기 — 둘 다 같은 안내
        setInfo(
          pending
            ? "가입 완료 — 관리자 승인 후 같은 이메일·비밀번호로 로그인할 수 있습니다."
            : "이 계정은 접근이 거부되었습니다. 관리자에게 문의하세요.",
        );
        setPassword("");
      }
    } catch (err) {
      setError(String(err).replace(/^Error:\s*\d+:\s*/, ""));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand">⬡ Millionvolt Hub</div>
        <div className="login-sub">
          {first ? (
            "첫 계정을 만들면 관리자가 됩니다."
          ) : (
            <>
              힉스필드 이메일로 로그인
              <br />
              처음이면 자동 등록 (관리자 승인 후 이용가능)
            </>
          )}
        </div>

        <input
          type="email"
          placeholder="힉스필드 이메일"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoFocus
          required
        />
        <input
          type="password"
          placeholder="비밀번호 (6자 이상)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <div className="login-hint">Agent 비밀번호입니다.</div>

        {error && <div className="login-error">{error}</div>}
        {info && <div className="login-info">{info}</div>}

        <button type="submit" className="login-submit" disabled={busy}>
          {busy ? "처리 중…" : first ? "관리자 계정 만들기" : "로그인 / 가입"}
        </button>
      </form>
    </div>
  );
}
