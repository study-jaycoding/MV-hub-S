// 팀 서버 로그인/가입 화면 — 로컬 허브(백엔드 AUTH off)에서 '로그인 필수'를 강제한다.
// 로컬에 별도 계정 DB 를 두지 않고, 팀 공유 서버 계정으로 로그인한다(= 단일 신원, 서버가 역할 관리).
// 가입: 작업자가 직접 가입 → 첫 계정은 자동 admin, 그 외는 승인대기(관리자 승인 후 로그인).
// 서버 주소는 화면에 입력칸으로 안 보인다(기본/설정값 사용) — 관리자가 관리자 창에서 바꾼다.
import { useState } from "react";
import { api } from "../api";

export function ServerLoginScreen({
  url,
  onConnected,
}: {
  url: string | null;
  onConnected: () => void;
}) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setNotice("");
    setBusy(true);
    try {
      if (mode === "login") {
        await api.sharedServerLogin(url, email.trim(), password); // url=null 이면 서버가 기본/설정값 사용
        onConnected();
      } else {
        const r = await api.sharedServerRegister(email.trim(), password, name.trim() || null);
        if (r.auto_logged_in) {
          onConnected(); // 첫 계정(=admin) 자동 승인 → 바로 진입
        } else {
          // 승인대기 — 로그인 모드로 돌아가 안내
          setMode("login");
          setPassword("");
          setNotice("가입 완료 — 관리자 승인 후 로그인하세요.");
        }
      }
    } catch (err) {
      setError(String(err).replace(/^Error:\s*\d+:\s*/, ""));
    } finally {
      setBusy(false);
    }
  };

  const isRegister = mode === "register";

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand">⬡ MV Hub</div>
        <div className="login-sub">
          {isRegister ? (
            <>
              팀 계정을 만드세요.
              <br />가입 후 관리자 승인을 받으면 로그인할 수 있습니다.
            </>
          ) : (
            <>
              팀 계정으로 로그인하세요.
              <br />이 계정으로 작업·공유가 기록됩니다(역할은 서버가 관리).
            </>
          )}
        </div>

        <input
          type="email"
          placeholder="이메일"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoFocus
          required
        />
        {isRegister && (
          <input
            type="text"
            placeholder="이름(표시용, 선택)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        )}
        <input
          type="password"
          placeholder="비밀번호"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <div className="login-hint">
          {isRegister
            ? "처음 가입하는 계정은 자동으로 관리자가 됩니다."
            : "공유 서버에서 admin 이 만든 내 팀 계정입니다."}
          {url ? ` · 서버: ${url}` : ""}
        </div>

        {notice && <div className="login-notice">{notice}</div>}
        {error && <div className="login-error">{error}</div>}

        <button type="submit" className="login-submit" disabled={busy}>
          {busy ? (isRegister ? "가입 중…" : "로그인 중…") : isRegister ? "가입" : "로그인"}
        </button>

        <button
          type="button"
          className="login-toggle"
          disabled={busy}
          onClick={() => {
            setMode(isRegister ? "login" : "register");
            setError("");
            setNotice("");
          }}
        >
          {isRegister ? "← 로그인으로 돌아가기" : "처음이세요? 가입하기"}
        </button>
      </form>
    </div>
  );
}
