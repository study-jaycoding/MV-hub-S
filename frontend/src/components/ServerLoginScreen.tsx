// 팀 서버 로그인/가입 화면 — 로컬 허브(백엔드 AUTH off)에서 '로그인 필수'를 강제한다.
// 로컬에 별도 계정 DB 를 두지 않고, 팀 공유 서버 계정으로 로그인한다(= 단일 신원, 서버가 역할 관리).
// 가입: 작업자가 직접 가입 → 첫 계정은 자동 admin, 그 외는 승인대기(관리자 승인 후 로그인).
//
// 서버 주소는 평소엔 접혀 있고(기본/설정값 사용, 관리자 창에서 변경), 서버가 이사하거나 IP 가
// 바뀌면 여기서 직접 고칠 수 있다 — 그렇지 않으면 로그인 실패 → 이 화면 → 주소를 바꿀 관리자
// 창은 로그인해야 열림 → UI 로 복구 불가한 데드락이 된다.
// 입력한 주소는 draft 다: 저장 버튼이 없고, 로그인·가입으로 세션이 실제로 생긴 주소만
// 백엔드가 영속한다(가입 후 승인대기는 세션이 없으므로 저장되지 않는다).
import { useState } from "react";
import { api } from "../api";
import { isUpstreamUnreachable } from "../lib/http";

export function ServerLoginScreen({
  url,
  urlHistory = [],
  onConnected,
}: {
  url: string | null;
  urlHistory?: string[];
  onConnected: () => void;
}) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [showServer, setShowServer] = useState(false);
  const [draftUrl, setDraftUrl] = useState(url || "");
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<{ ok: boolean; text: string } | null>(null);

  const message = (err: unknown) => String(err).replace(/^Error:\s*\d+:\s*/, "");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setNotice("");
    setBusy(true);
    try {
      // draft 주소를 그대로 실어 보낸다(비우면 백엔드가 기본/설정값 사용). 로그인·가입 모두
      // 세션이 실제로 생길 때만 백엔드가 이 주소를 저장하고, 실패하면 아무것도 바뀌지 않는다.
      const serverUrl = draftUrl.trim() || null;
      if (mode === "login") {
        await api.sharedServerLogin(serverUrl, email.trim(), password);
        onConnected();
      } else {
        const r = await api.sharedServerRegister(
          serverUrl,
          email.trim(),
          password,
          name.trim() || null,
        );
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
      setError(message(err));
      if (isUpstreamUnreachable(err)) {
        // 자격증명이 아니라 '서버에 못 닿음' — 주소부터 확인할 수 있게 패널을 펼친다.
        setShowServer(true);
        setNotice("서버에 연결하지 못했습니다. 아래에서 서버 주소를 확인하세요.");
      }
    } finally {
      setBusy(false);
    }
  };

  const probe = async () => {
    setProbing(true);
    setProbeResult(null);
    try {
      const r = await api.sharedServerProbe(draftUrl.trim());
      setProbeResult({
        ok: r.ok,
        text: r.ok
          ? `연결 성공 — MV Hub 서버${r.server_version ? ` (CLI ${r.server_version})` : ""}`
          : r.reason || "확인하지 못했습니다",
      });
    } catch (err) {
      setProbeResult({ ok: false, text: message(err) });
    } finally {
      setProbing(false);
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
          onClick={() => setShowServer((v) => !v)}
        >
          {showServer ? "▾ 서버 주소 변경" : "▸ 서버 주소 변경"}
        </button>

        {showServer && (
          <div className="login-server">
            <div className="login-hint">현재 주소: {url || "(기본값)"}</div>
            <input
              type="text"
              placeholder="http://192.168.1.199:8010"
              value={draftUrl}
              onChange={(e) => {
                setDraftUrl(e.target.value);
                setProbeResult(null);
              }}
            />
            {urlHistory.length > 0 && (
              <select
                value=""
                onChange={(e) => {
                  if (!e.target.value) return;
                  setDraftUrl(e.target.value);
                  setProbeResult(null);
                }}
              >
                <option value="">최근에 쓰던 주소…</option>
                {urlHistory.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              className="login-toggle"
              disabled={probing || !draftUrl.trim()}
              onClick={probe}
            >
              {probing ? "확인 중…" : "연결 테스트"}
            </button>
            {probeResult && (
              <div className={probeResult.ok ? "login-notice" : "login-error"}>
                {probeResult.text}
              </div>
            )}
            <div className="login-hint">
              여기서 바꾼 주소는 저장되지 않습니다 — 이 주소로 로그인(또는 첫 계정 가입)에
              성공하면 저장됩니다.
            </div>
          </div>
        )}

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
