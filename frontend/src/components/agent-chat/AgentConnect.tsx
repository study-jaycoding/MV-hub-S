// MV Agent 칸의 Claude 연결 안내(첫 연결 설계 3·6·9절 · 시안 ask-agent-connect1/2.png). 상태마다 한 장면:
//  설치(MV Hub 실행기가 공식 설치를 돌린다 — 설치 중이면 기다림·손 설치는 접음, 실패·건너뜀이면 그 줄 + 손 설치 안내 —
//  docs/status/MVAgent_ClaudeCode업데이트_2026-11-10.md 2-v3-1b) · 업데이트 · 확인 못 함 · 연결(로그인 창 스위치가 켜졌을 때만
//  [Claude 연결], 꺼졌거나 창을 열 수 없으면 터미널 안내) · 구독 아님 · 구독 없음 · 로그인 창 열림(기다림).
import { useState } from "react";
import type { ClaudeInstall, ClaudeState } from "../../lib/agentChatApi";
import { useT } from "../../lib/i18n";

export const INSTALL_COMMAND = "irm https://claude.ai/install.ps1 | iex"; // 공식 문서(code.claude.com/docs/en/setup) PowerShell
const UPDATE_COMMAND = "claude update";
const LOGIN_COMMAND = "claude auth login";

interface Props {
  state: ClaudeState | null;
  version: string | null;
  install?: ClaudeInstall | null; // 실행기의 공식 설치 표식(허브가 읽어 준다) — 옛 허브는 없음
  loginWindowEnabled: boolean;
  waiting: boolean;
  connecting?: boolean;
  connectError?: string | null;
  note: "terminal" | "expired" | "unfinished" | null;
  onConnect: () => void;
  onRecheck: () => void;
  onStopWaiting: () => void;
}

export function CopyLine({ command }: { command: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(command).then(() => setCopied(true), () => setCopied(false));
  };
  return (
    <div className="cn-code">
      <span>{command}</span>
      <button type="button" className="cn-copy" onClick={copy} aria-label={t("명령 복사")}>{copied ? t("복사됨") : t("복사")}</button>
    </div>
  );
}

function Steps({ installed, version, login }: { installed: boolean; version: string | null; login: "todo" | "now" | "wait" | "warn" }) {
  const t = useT();
  return (
    <ol className="cn-steps">
      <li className={installed ? "ok" : "now"}>
        <span className="d" aria-hidden="true">{installed ? "✓" : "1"}</span>{installed ? t("Claude Code 설치됨") : t("Claude Code 설치")}
        <small>{installed ? version ?? "" : t("없음")}</small>
      </li>
      <li className={login === "todo" ? "" : login === "wait" ? "now wait" : "now"}>
        <span className="d" aria-hidden="true">{login === "warn" ? "!" : login === "wait" ? "" : "2"}</span>{t("Claude 로그인")}
        <small>{login === "wait" ? t("로그인 창 기다리는 중") : login === "warn" ? t("다시 연결 필요") : login === "now" ? t("아직 안 됨") : ""}</small>
      </li>
    </ol>
  );
}

export function Terminal({ onRecheck }: { onRecheck: () => void }) {
  const t = useT();
  return (
    <>
      <b>{t("PowerShell 로 연결")}</b>
      <p>{t("터미널(PowerShell)에서 아래 명령을 실행해 브라우저로 로그인하세요. 끝나면 [다시 확인].")}</p>
      <CopyLine command={LOGIN_COMMAND} />
      <button type="button" className="cn-ghost" onClick={onRecheck}>{t("다시 확인")}</button>
    </>
  );
}

// 실행기가 건너뛴 까닭(표식 last_skip.reason) — 손 설치 안내 위에 한 줄
const SKIP_TEXT: Record<string, string> = {
  elevated: "관리자 권한으로 켠 MV Hub 라 자동 설치를 건너뛰었어요",
  not_interactive: "이 Windows 로그인에서는 자동 설치를 하지 않아요",
  service_account: "이 Windows 로그인에서는 자동 설치를 하지 않아요",
  token_unknown: "권한을 확인하지 못해 자동 설치를 건너뛰었어요",
};

export function InstallNote({ install }: { install?: ClaudeInstall | null }) {
  const t = useT();
  if (install?.state === "failed") return <p className="cn-note cn-warn" role="status">{t("자동 설치가 안 됐어요 — 아래처럼 직접 설치해 주세요")}</p>;
  if (install?.state !== "skipped") return null;
  return <p className="cn-note" role="status">{t(SKIP_TEXT[install.reason ?? ""] ?? "자동 설치를 건너뛰었어요")} — {t("아래처럼 직접 설치해 주세요")}</p>;
}

export function ManualInstall({ onRecheck }: { onRecheck: () => void }) {
  const t = useT();
  return (
    <>
      <ol className="cn-list">
        <li><b>PowerShell</b> {t("을 열어요(시작 메뉴에서 검색)")}</li>
        <li>{t("아래 명령을 붙여 넣고 Enter")}</li>
      </ol>
      <CopyLine command={INSTALL_COMMAND} />
      <ol className="cn-list" start={3}><li>{t("끝나면 [다시 확인]")}</li></ol>
      <button type="button" className="cn-ghost" onClick={onRecheck}>{t("다시 확인")}</button>
    </>
  );
}

export function ManualLogin({ onRecheck }: { onRecheck: () => void }) {
  const t = useT();
  return <details className="cn-more"><summary>{t("직접 하려면(PowerShell)")}</summary><Terminal onRecheck={onRecheck} /></details>;
}

export function LoginWindowGuide({ waiting, note, onRecheck, onStopWaiting }: Pick<Props, "waiting" | "note" | "onRecheck" | "onStopWaiting">) {
  const t = useT();
  return <>
    <p>{t("Claude 로그인 창을 열었어요. 브라우저에 claude.ai 로그인이 뜨면 이 PC 를 쓰는 사람의 계정으로 로그인하고 승인해 주세요. 로그인을 마치고 그 창이 닫히면 여기가 바뀌어요.")}</p>
    <p className="cn-note">{t("브라우저가 안 열리면 그 창에서 c 를 눌러 주소를 복사해 브라우저에 붙여 넣어요. 브라우저가 코드를 보여 주면 그 창에 붙여 넣어요.")}</p>
    {waiting ? <div><button type="button" className="cn-text" onClick={onStopWaiting}>{t("그만두기")}</button>{" "}<small className="cn-note">{t("자동 확인만 멈춰요 · 로그인 창은 직접 닫아 주세요")}</small></div>
      : <>{note === "expired" && <p className="cn-note">{t("아직 로그인 창이 열려 있어요 — 마치면 [다시 확인]")}</p>}<button type="button" className="cn-ghost" onClick={onRecheck}>{t("다시 확인")}</button></>}
  </>;
}

export function AgentConnect({ state, version, install, loginWindowEnabled, waiting, connecting, connectError, note, onConnect, onRecheck, onStopWaiting }: Props) {
  const t = useT();
  const terminal = !loginWindowEnabled || note === "terminal";
  const body = (() => {
    switch (state) {
      case "not_installed":
        if (install?.state === "running") {
          // 설치 중 — 칸이 3초마다 다시 보고 끝나면 다음 단계로 넘어간다. 손 설치는 접어 둔다(겹쳐 설치하지 않게)
          return (
            <>
              <h3>{t("MV Hub 가 Claude Code 를 설치하는 중이에요")}</h3>
              <p>{t("끝나면 저절로 이어져요. MV Hub 를 닫으면 설치가 멈추고, 다음에 켤 때 다시 해요.")}</p>
              <ol className="cn-steps">
                <li className="now wait"><span className="d" aria-hidden="true" />{t("Claude Code 설치")}<small>{t("설치하는 중")}</small></li>
                <li><span className="d" aria-hidden="true">2</span>{t("Claude 로그인")}</li>
              </ol>
              <details className="cn-more">
                <summary>{t("직접 설치하려면")}</summary>
                <ManualInstall onRecheck={onRecheck} />
              </details>
            </>
          );
        }
        return (
          <>
            <h3>{t("이 PC 에 Claude Code 가 없어요")}</h3>
            <InstallNote install={install} />
            <p>{t("아래 순서로 설치하면 이어서 연결해요.")}</p>
            <ManualInstall onRecheck={onRecheck} />
          </>
        );
      case "outdated":
        return (
          <>
            <h3>{t("Claude Code 를 업데이트해야 해요")}</h3>
            <p>{t("터미널에서 아래 명령을 실행한 뒤 [다시 확인].")}</p>
            <CopyLine command={UPDATE_COMMAND} />
            <button type="button" className="cn-ghost" onClick={onRecheck}>{t("다시 확인")}</button>
          </>
        );
      case "login_window":
        return (
          <>
            <h3>{t("열린 창에서 로그인을 마쳐 주세요")}</h3>
            <Steps installed version={version} login={waiting ? "wait" : "now"} />
            <LoginWindowGuide waiting={waiting} note={note} onRecheck={onRecheck} onStopWaiting={onStopWaiting} />
          </>
        );
      case "not_subscription":
      case "no_plan":
      case "not_logged_in": {
        const head = state === "not_logged_in" ? t("Claude 를 연결하세요")
          : state === "no_plan" ? t("이 계정엔 Claude Code 를 쓸 수 있는 구독이 없어요") : t("구독 로그인이 아니에요");
        const lead = state === "not_logged_in" ? t("이 PC 의 Claude 로그인으로 MV Hub 일을 같이 해요. API 키 없이 내 Claude 구독 사용량을 써요.")
          : state === "no_plan" ? t("Pro·Max·Ultra·Team·Enterprise 구독 계정으로 다시 연결하세요.")
          : t("지금 Claude 가 API 키(Console)로 로그인돼 있어요. 이 칸은 API 요금이 들지 않게 구독 로그인만 써요.");
        const action = state === "not_logged_in" ? t("Claude 연결") : state === "no_plan" ? t("다른 계정으로 연결") : t("구독으로 다시 연결");
        return (
          <>
            <h3>{head}</h3>
            <p className={state === "not_logged_in" ? "" : "cn-warn"}>{lead}</p>
            <Steps installed version={version} login={state === "not_logged_in" ? "now" : "warn"} />
            {note === "unfinished" && <p className="cn-note" role="status">{t("로그인을 마치지 못했어요 — 다시 해 주세요")}</p>}
            {terminal ? <Terminal onRecheck={onRecheck} /> : (
              <>
                <button type="button" className="cn-go" disabled={connecting || waiting} onClick={onConnect}>{connecting ? t("연결 요청 중") : action}</button>
                <p className="cn-note">{t("누르면 Claude 로그인 창이 열리고 브라우저에 claude.ai 로그인이 떠요. 로그인을 마치고 그 창이 닫히면 여기가 바뀌어요.")}</p>
                <ManualLogin onRecheck={onRecheck} />
              </>
            )}
            {state !== "not_logged_in" && <p className="cn-note">{t("이 PC 에서 Claude 를 쓰는 다른 곳(터미널 등)의 로그인도 함께 바뀌어요")}</p>}
          </>
        );
      }
      default: { // unknown·window_record·null
        // 공식 파일은 있으나 안 돌고 자동 설치가 실패·건너뜀 — 그 줄이 말한 손 설치로 바로 이어 준다(설치 독립 리뷰 P2)
        const manual = state !== "window_record" && (install?.state === "failed" || install?.state === "skipped");
        return (
          <>
            <h3>{t("Claude 상태를 확인하지 못했어요")}</h3>
            {state === "window_record" && <p>{t("열린 Claude 로그인 창을 닫고 [다시 확인]을 눌러 주세요.")}</p>}
            {state !== "window_record" && <InstallNote install={install} />}
            {manual ? <ManualInstall onRecheck={onRecheck} /> : <button type="button" className="cn-ghost" onClick={onRecheck}>{t("다시 확인")}</button>}
          </>
        );
      }
    }
  })();
  return (
    <section className="cn" aria-label={t("Claude 연결")} role="status">
      <div className="cn-mark" aria-hidden="true"><i className="mv-mark full" /></div>
      {body}
      {connectError && <p className="cn-note cn-warn" role="alert">{connectError}</p>}
      <p className="cn-note">{t("대화는 내 Claude 구독 사용량을 써요(한도를 넘으면 내 Claude 추가 사용 설정대로) · [실행]만 MV 크레딧 · 이 PC 의 MV 계정은 같은 Claude 로그인을 써요")}</p>
    </section>
  );
}
