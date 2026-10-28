import { useEffect, useRef, useState } from "react";
import { getAuthToken, HttpError, jsonBody, jsonFetch } from "../../lib/http";
import { useT } from "../../lib/i18n";

interface VersionState {
  selected_version: string;
  bundle_version: string;
  source: "bundle" | "downloaded";
  selection_reason: string;
  manifest_sha256?: string | null;
  rollback_available?: boolean;
  published?: { version: string; commit: string; manifest_sha256: string } | null;
  available?: boolean;
  compatible?: boolean;
  checked?: boolean;
  settings_preserved?: boolean;
  reload_required?: boolean;
  note: string;
}

export function McpUpdate({ authReady, authKey }: { authReady: boolean; authKey: string }) {
  const t = useT();
  const [state, setState] = useState<VersionState | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [confirm, setConfirm] = useState<"update" | "rollback" | null>(null);
  const pending = useRef(false), active = useRef(true), tab = useRef(crypto.randomUUID());
  const scope = JSON.stringify([authReady, authKey]);
  const currentScope = useRef(scope);
  const epoch = useRef(0);
  if (currentScope.current !== scope) { currentScope.current = scope; epoch.current += 1; }
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => { setState(null); setNote(""); setConfirm(null); }, [scope]);

  async function request(action: "check" | "update" | "rollback") {
    if (pending.current || !authReady) return;
    if (action === "update" && (!state?.available || !state.published || !state.compatible)) return;
    if (action === "rollback" && (!state?.rollback_available || !state.manifest_sha256)) return;
    const version = state?.published;
    const ticket = epoch.current, token = getAuthToken();
    const fresh = () => active.current && ticket === epoch.current && token === getAuthToken();
    pending.current = true; setBusy(true); setConfirm(null);
    setNote(action === "check" ? "게시된 MCP 버전을 확인하고 있습니다." : "MCP 파일을 검증하고 다음 실행 버전을 준비하고 있습니다.");
    try {
      const result = await jsonFetch<VersionState>(`/api/mcp/app/adapter${action === "check" ? "" : `/${action}`}`, {
        method: action === "check" ? "GET" : "POST", headers: { "X-MVHub-Tab": tab.current },
        ...(action !== "check" ? { body: jsonBody({ expected_manifest_sha256: action === "update" ? version!.manifest_sha256 : state!.manifest_sha256 }) } : {}),
      });
      if (fresh()) { setState(result); setNote(result.note); }
    } catch (error) {
      if (fresh()) {
        setState(null);
        setNote(error instanceof HttpError && error.detail ? error.detail :
          action === "check" ? "MCP 버전을 확인하지 못했습니다. 로그인과 연결을 확인한 뒤 다시 시도하세요." :
            "업데이트 결과를 확인하지 못했습니다. 새 MCP 버전 확인을 눌러 현재 상태를 확인하세요.");
      }
    } finally { pending.current = false; if (active.current) setBusy(false); }
  }

  const disabled = busy || !authReady;
  return <section aria-label={t("MCP 업데이트")} className="mcp-result" data-status={state?.reload_required ? "configured" : "manual"}>
    <h3 className="mcp-reg-title">{t("MCP 업데이트")}</h3>
    <p>{t("MV Hub 본체와 별도로 MCP 연결 프로그램을 업데이트합니다. 처음 도입할 때는 본체 업데이트가 한 번 필요합니다.")}</p>
    {state && <dl>
      <dt>{t("다음 연결에 사용할 버전")}</dt><dd>{state.selected_version} ({t(state.source === "bundle" ? "본체 포함" : "별도 업데이트")})</dd>
      <dt>{t("본체에 포함된 버전")}</dt><dd>{state.bundle_version}</dd>
      {state.published && <><dt>{t("팀 게시 버전")}</dt><dd>{state.published.version} · {state.published.commit.slice(0, 12)}</dd></>}
    </dl>}
    {state?.selection_reason && <p>{t(state.selection_reason)}</p>}
    <div className="mcp-actions">
      <button disabled={disabled} onClick={() => void request("check")}>{t("새 MCP 버전 확인")}</button>
      {state?.available && state.compatible && <button disabled={disabled} onClick={() => setConfirm("update")}>{t("MCP 업데이트")}</button>}
      {state?.rollback_available && <button disabled={disabled} onClick={() => setConfirm("rollback")}>{t("이전 MCP 버전으로")}</button>}
    </div>
    {confirm && <div className="mcp-reg-consent">
      <p>{confirm === "update" ? `${state?.published?.version} ${t("버전으로 준비합니다. 기존 연결 설정은 유지됩니다.")}` : t("이전 MCP 버전으로 되돌립니다. 처음 업데이트한 경우 본체에 포함된 버전을 사용합니다.")}</p>
      <button disabled={disabled} onClick={() => void request(confirm)}>{t(confirm === "update" ? "이 버전으로 업데이트" : "이전 버전 준비")}</button>
      <button disabled={disabled} onClick={() => setConfirm(null)}>{t("취소")}</button>
    </div>}
    <p role="status" aria-live="polite">{t(note)}</p>
    {state?.settings_preserved && <p>{t("기존 MCP 연결 설정을 보존했습니다.")}</p>}
    {state?.reload_required && <p>{t("이미 열린 Codex·Claude Code는 MCP를 다시 불러오거나 재시작해야 새 버전을 사용합니다.")}</p>}
  </section>;
}
