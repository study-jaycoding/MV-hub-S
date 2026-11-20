import { useT } from "../../lib/i18n";
import { changeScreenControl, SCREEN_CONSENT, screenMessage, selectScreenWindow, useScreenControl, type ScreenNotice } from "../../lib/useMcpScreenActions";
import "./mcp.css";

export function McpScreenControl() {
  const state = useScreenControl(), t = useT();
  return <div className="mcp-screen-control">
    <label><input type="checkbox" checked={state.enabled} disabled={!state.available} onChange={e => changeScreenControl(e.target.checked)} />{t("바깥 앱 화면 제어")}</label>
    <p>{t(SCREEN_CONSENT)}</p>
    {!state.available && <p>{t("MV Hub 본창에서 허브 연결을 확인한 뒤 켜 주세요")}</p>}
    {state.enabled && state.multiple && <button type="button" disabled={state.selected} onClick={selectScreenWindow}>{t(state.selected ? "이 창을 사용 중" : "이 창 사용")}</button>}
    {state.note && <p role="status">{t(state.note)}</p>}
  </div>;
}

export function McpScreenNotice({ notices, undo, dismiss }: { notices: ScreenNotice[]; undo: (id: string) => void; dismiss: (id: string) => void }) {
  const t = useT();
  if (!notices.length) return null;
  return <aside className="mcp-screen-notices" aria-label={t("최근 화면 동작")} aria-live="polite">
    <strong>{t("최근 화면 동작")}</strong>
    {notices.map(n => <div key={n.id}><span>{n.client}: {screenMessage(n.summary)}</span>
      {n.undo && <button type="button" onClick={() => undo(n.id)}>{t("되돌리기")}</button>}
      <button type="button" aria-label={t("알림 닫기")} onClick={() => dismiss(n.id)}>×</button>
      {n.note && <p>{t(n.note)}</p>}
    </div>)}
  </aside>;
}
