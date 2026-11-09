// MV Agent 칸의 Claude 연결 안내(첫 연결 설계 3·6·9절 · 시안 ask-agent-connect1/2.png). 상태마다 한 장면:
//  설치 안내(B — 앱은 설치를 실행하지 않는다) · 업데이트 · 확인 못 함 · 연결(로그인 창 스위치가 켜졌을 때만 [Claude 연결],
//  꺼졌거나 창을 열 수 없으면 터미널 안내) · 구독 아님 · 구독 없음 · 로그인 창 열림(기다림).
import { useState } from "react";
import type { ClaudeState } from "../../lib/agentChatApi";
import { useT } from "../../lib/i18n";

export const INSTALL_COMMAND = "irm https://claude.ai/install.ps1 | iex"; // 공식 문서(code.claude.com/docs/en/setup) PowerShell
const UPDATE_COMMAND = "claude update";
const LOGIN_COMMAND = "claude auth login";

interface Props {
  state: ClaudeState | null;
  version: string | null;
  loginWindowEnabled: boolean;
  waiting: boolean;
  note: "terminal" | "expired" | "unfinished" | null;
  onConnect: () => void;
  onRecheck: () => void;
  onStopWaiting: () => void;
}

function CopyLine({ command }: { command: string }) {
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

function Terminal({ onRecheck }: { onRecheck: () => void }) {
  const t = useT();
  return (
    <>
      <p>{t("터미널(PowerShell)에서 아래 명령을 실행해 브라우저로 로그인하세요. 끝나면 [다시 확인].")}</p>
      <CopyLine command={LOGIN_COMMAND} />
      <button type="button" className="cn-ghost" onClick={onRecheck}>{t("다시 확인")}</button>
    </>
  );
}

export function AgentConnect({ state, version, loginWindowEnabled, waiting, note, onConnect, onRecheck, onStopWaiting }: Props) {
  const t = useT();
  const terminal = !loginWindowEnabled || note === "terminal";
  const body = (() => {
    switch (state) {
      case "not_installed":
        return (
          <>
            <h3>{t("이 PC 에 Claude Code 가 없어요")}</h3>
            <p>{t("아래 순서로 설치하면 이어서 연결해요.")}</p>
            <ol className="cn-list">
              <li><b>PowerShell</b> {t("을 열어요(시작 메뉴에서 검색)")}</li>
              <li>{t("아래 명령을 붙여 넣고 Enter")}</li>
            </ol>
            <CopyLine command={INSTALL_COMMAND} />
            <ol className="cn-list" start={3}><li>{t("끝나면 [다시 확인]")}</li></ol>
            <button type="button" className="cn-ghost" onClick={onRecheck}>{t("다시 확인")}</button>
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
            <p>{t("브라우저가 안 열리면 그 창에서 c 를 눌러 주소를 복사해요. 마치면 여기가 알아서 바뀌어요.")}</p>
            <Steps installed version={version} login="wait" />
            {waiting
              ? <button type="button" className="cn-text" onClick={onStopWaiting}>{t("그만두기")}</button>
              : <>{note === "expired" && <p className="cn-note">{t("아직 로그인 창이 열려 있어요 — 마치면 [다시 확인]")}</p>}
                <button type="button" className="cn-ghost" onClick={onRecheck}>{t("다시 확인")}</button></>}
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
                <button type="button" className="cn-go" onClick={onConnect}>{action}</button>
                <p className="cn-note">{t("누르면 Claude 로그인 창이 열리고, 그 창이 브라우저에 claude.ai 로그인을 띄워요")}</p>
              </>
            )}
            {state !== "not_logged_in" && <p className="cn-note">{t("이 PC 에서 Claude 를 쓰는 다른 곳(터미널 등)의 로그인도 함께 바뀌어요")}</p>}
          </>
        );
      }
      default: // unknown·window_record·null
        return (
          <>
            <h3>{t("Claude 상태를 확인하지 못했어요")}</h3>
            {state === "window_record" && <p>{t("열린 Claude 로그인 창을 닫고 [다시 확인]을 눌러 주세요.")}</p>}
            <button type="button" className="cn-ghost" onClick={onRecheck}>{t("다시 확인")}</button>
          </>
        );
    }
  })();
  return (
    <section className="cn" aria-label={t("Claude 연결")} role="status">
      <div className="cn-mark" aria-hidden="true">⬡</div>
      {body}
      <p className="cn-note">{t("대화는 내 Claude 구독 사용량을 써요(한도를 넘으면 내 Claude 추가 사용 설정대로) · [실행]만 MV 크레딧 · 이 PC 의 MV 계정은 같은 Claude 로그인을 써요")}</p>
    </section>
  );
}
