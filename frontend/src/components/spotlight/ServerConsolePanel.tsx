// 서버 콘솔 패널 — 상태줄 왼쪽 "● 서버 연결됨" 토글. 누르면 cmd 창에 보이던 정보
// (앱 버전·CLI·에이전트/허브 로그 꼬리)를 패널로 펼치고, 다시 누르면 접는다.
import { useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { isAppWindow } from "../../lib/appWindow";
import type { ConsoleSummary } from "../../types";

const MODE_LABEL: Record<string, string> = {
  release: "릴리스 설치본",
  server: "공유 서버",
  development: "개발 실행",
};

function agoText(epochSeconds: number | null): string {
  if (!epochSeconds) return "";
  const diff = Math.max(0, Math.round(Date.now() / 1000 - epochSeconds));
  if (diff < 10) return "방금";
  if (diff < 60) return `${diff}초 전`;
  if (diff < 3600) return `${Math.round(diff / 60)}분 전`;
  return `${Math.round(diff / 3600)}시간 전`;
}

function LogTail({ title, tail }: { title: string; tail: ConsoleSummary["agent_log"] }) {
  const boxRef = useRef<HTMLPreElement>(null);
  // 새 내용이 오면 끝으로 스크롤 — cmd 창처럼 최신 줄이 보이게.
  useEffect(() => {
    const box = boxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [tail.lines]);
  return (
    <>
      <div className="sl-console-log-head">
        {title}
        {tail.exists && tail.updated_at ? ` · ${agoText(tail.updated_at)} 갱신` : ""}
      </div>
      <pre className="sl-console-log" ref={boxRef}>
        {tail.exists
          ? tail.lines.join("\n") || "(비어 있음)"
          : "(로그 파일 없음)"}
      </pre>
    </>
  );
}

interface AccountInfo {
  credits: number | null;
  email: string;
}

export function ServerConsolePanel({
  hubOk,
  agentOn,
  account,
  onCheckAccount,
}: {
  hubOk: boolean | null; // 허브(로컬 서버) 응답 여부 — null=확인 전
  agentOn: boolean | null; // 생성 에이전트 롱폴 연결 여부
  account: AccountInfo | null;
  onCheckAccount: () => void; // '연결됨' 클릭 = 크레딧 수동 확인(종전 동작)
}) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<ConsoleSummary | null>(null);
  const [error, setError] = useState("");
  // 앱 종료 확인창(우리 디자인) — [종료] 확인 시 OS 측 창 닫기 요청(감시자가 전체 정리).
  const [confirmExit, setConfirmExit] = useState(false);
  const [exiting, setExiting] = useState(false);
  const requestExit = () => {
    setExiting(true);
    api.closeApp().catch((e) => {
      setExiting(false);
      setConfirmExit(false);
      setError(String(e));
      setOpen(true);
    });
  };

  // 열려 있는 동안만 5초 간격 갱신 — 닫으면 폴링 없음.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    const load = () => {
      api
        .consoleSummary()
        .then((summary) => {
          if (!alive) return;
          setData(summary);
          setError("");
        })
        .catch((e) => alive && setError(String(e)));
    };
    load();
    const id = window.setInterval(load, 5000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [open]);

  const hubLabel = data
    ? [
        data.app_version ? `v${data.app_version}` : "",
        MODE_LABEL[data.install_mode] || data.install_mode,
        `포트 ${data.port}`,
      ]
        .filter(Boolean)
        .join(" · ")
    : "불러오는 중…";
  const cliLabel = data
    ? data.cli.available
      ? `${data.cli.pinned ? `${data.cli.pinned} 고정 · ` : ""}${data.cli.path}`
      : "CLI 를 찾지 못함"
    : "";

  return (
    <>
      {open && (
        <>
          {/* 화면 중앙 플로팅 창 — ✕ 로만 닫힘(백드롭 없음: 뒤 화면 계속 조작 가능) */}
          <div className="manage-float host-console-float" role="dialog" aria-label="Host 콘솔">
            <header className="admin-head">
              <span className="admin-title">🖥 Host 콘솔</span>
              <button className="assets-x" onClick={() => setOpen(false)} title="닫기">
                ✕
              </button>
            </header>
            <div className="admin-body">
              {error ? (
                <div className="sl-console-error">{error}</div>
              ) : (
                <>
                  <div className="sl-console-grid">
                    <span>허브</span>
                    <span>{hubLabel}</span>
                    <span>CLI</span>
                    <span title={data?.cli.path || undefined}>{cliLabel}</span>
                    <span>에이전트</span>
                    <span>
                      {agentOn == null ? "확인 중…" : agentOn ? "● 대기 중 (생성 가능)" : "꺼짐"}
                    </span>
                  </div>
                  {data && <LogTail title="에이전트 로그" tail={data.agent_log} />}
                  {data && <LogTail title="허브 로그" tail={data.hub_log} />}
                </>
              )}
              {isAppWindow() && (
                <div className="host-exit-row">
                  <button
                    type="button"
                    className="settings-action ghost"
                    onClick={() => setConfirmExit(true)}
                    title="MV Hub 를 종료합니다 — 허브·생성 에이전트도 함께 꺼집니다"
                  >
                    ⏻ 앱 종료
                  </button>
                </div>
              )}
            </div>
          </div>
        </>
      )}
      {confirmExit && (
        <div className="manage-float host-exit-confirm" role="alertdialog" aria-label="앱 종료">
          <header className="admin-head">
            <span className="admin-title">⏻ MV Hub 종료</span>
          </header>
          <div className="admin-body">
            <p className="host-exit-text">
              앱을 종료하면 허브와 생성 에이전트도 함께 꺼집니다. 진행 중인 힉스필드 생성은
              계속되고, 다음 실행 때 결과를 이어받습니다.
            </p>
            <div className="host-exit-actions">
              <button
                type="button"
                className="settings-action"
                onClick={requestExit}
                disabled={exiting}
              >
                {exiting ? "종료 중…" : "종료"}
              </button>
              <button
                type="button"
                className="settings-action ghost"
                onClick={() => setConfirmExit(false)}
                disabled={exiting}
              >
                취소
              </button>
            </div>
          </div>
        </div>
      )}
      {/* 통합 상태 컨트롤: ● Host/연결됨 · 크레딧 · 이메일
          점 색 = 녹(둘 다 정상) / 노(허브만 정상, 에이전트 꺼짐) / 빨(허브 응답 없음) / 회(확인 전).
          Host·연결됨은 각각 호버 시 하얗게, 클릭 시 각자의 동작(콘솔 열기 / 크레딧 확인). */}
      <div className="sl-status sl-status-combo">
        <span
          className={
            "sl-status-dot" +
            (hubOk == null ? "" : !hubOk ? " bad" : agentOn ? " on" : " warn")
          }
          title={
            hubOk == null
              ? "상태 확인 중"
              : !hubOk
                ? "허브 응답 없음 — MV_agent.bat 실행 상태를 확인하세요"
                : agentOn
                  ? "허브·에이전트 정상"
                  : "허브는 정상, 생성 에이전트 꺼짐 — 생성하려면 에이전트 실행"
          }
        />
        <button
          type="button"
          className="sl-combo-part"
          title="Host 콘솔 — cmd 창에 보이던 정보를 여기서 확인"
          onClick={() => setOpen((value) => !value)}
        >
          Host
        </button>
        <span className="sl-combo-slash" aria-hidden="true">/</span>
        <button
          type="button"
          className="sl-combo-part"
          title="생성·재생성은 내 PC의 에이전트가 켜져 있어야 실행됩니다(MV_agent.bat). 클릭=크레딧 확인"
          onClick={onCheckAccount}
        >
          {hubOk == null
            ? "확인 중…"
            : !hubOk
              ? "연결 안 됨"
              : agentOn
                ? "연결됨"
                : "에이전트 꺼짐"}
        </button>
        {account?.credits != null && (
          <>
            <span className="sl-status-sep">·</span>
            <span className="sl-status-credits">
              {account.credits.toLocaleString(undefined, { maximumFractionDigits: 2 })} credits
            </span>
          </>
        )}
        {account?.email && (
          <>
            <span className="sl-status-sep">·</span>
            <span className="sl-status-user" title={account.email}>
              {account.email}
            </span>
          </>
        )}
      </div>
    </>
  );
}
