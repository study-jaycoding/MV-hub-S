// 서버 콘솔 패널 — 상태줄 왼쪽 "● 서버 연결됨" 토글. 누르면 cmd 창에 보이던 정보
// (앱 버전·CLI·에이전트/허브 로그 꼬리)를 패널로 펼치고, 다시 누르면 접는다.
import { useEffect, useRef, useState } from "react";
import { api } from "../../api";
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

export function ServerConsolePanel({ agentOn }: { agentOn: boolean | null }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<ConsoleSummary | null>(null);
  const [error, setError] = useState("");

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
    <div className="sl-console">
      {open && (
        <div className="sl-console-panel">
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
        </div>
      )}
      <button
        type="button"
        className="sl-status sl-console-toggle"
        title="서버 콘솔 — cmd 창에 보이던 정보를 여기서 확인"
        onClick={() => setOpen((value) => !value)}
      >
        <span className={"sl-status-dot" + (agentOn ? " on" : "")} />
        <span>서버</span>
        <span aria-hidden="true">{open ? "▾" : "▴"}</span>
      </button>
    </div>
  );
}
