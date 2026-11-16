import { useCallback, useEffect, useRef, useState } from "react";
import { getAuthToken, jsonBody, jsonFetch } from "../../lib/http";
import { useT } from "../../lib/i18n";
import { mcpTabId } from "../../lib/mcpTab";

// 설정 옆 창의 MV·MCP 연결(Jay 2026-11-16 시안 v3) — [한 번에 연결] 하나와 앱마다 상태·[해제]/[다시 연결].
//  등록·목록·해제는 MCP 창(McpRegistration)과 같은 API 다. 옛 6자리 연결·다른 MCP 프로그램·MCP 업데이트는 MCP 창(고급)에 남는다.
const APPS = [
  { key: "codex", label: "Codex", sub: "CLI · 앱 · IDE" },
  { key: "claude", label: "Claude Code", sub: "CLI · IDE · 데스크톱 Code 탭" },
  { key: "claude_desktop", label: "Claude 데스크톱 채팅", sub: "Claude 앱의 채팅" },
] as const;
type AppKey = (typeof APPS)[number]["key"];
interface Client { id: string; name: string; revoked_at: string | null; last_seen_at?: string | null }
interface Registration { client: string; status: "configured" | "manual" | "skipped" | "error"; message: string; config?: unknown }

const PILL: Record<string, [string, string]> = {
  on: ["연결됨", "on"],
  registered: ["등록됨", "on"],
  skipped: ["건너뜀", "warn"],
  error: ["실패", "warn"],
  manual: ["수동 등록 필요", "warn"],
  off: ["연결 안 됨", "off"],
  loading: ["확인 중", "off"],
  unknown: ["확인 못 함", "off"],
};

export function McpQuickConnect({ onSummary, onOpenWindow }: { onSummary?: (text: string) => void; onOpenWindow: () => void }) {
  const t = useT();
  const [clients, setClients] = useState<Client[] | null>(null);
  const [results, setResults] = useState<Partial<Record<AppKey, Registration>>>({});
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [note, setNote] = useState("");
  const tab = useRef(mcpTabId()); // LAN HTTP 에도 있는 생성 길로(Codex 리뷰 01a1e38d)
  const pending = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  // 일 하나씩 — 끝나면 목록을 다시 읽는다(일이 함수를 돌려주면 다시 읽은 목록으로 결과 문구를 정한다). 그사이 로그인이 바뀌었으면 결과를 버린다.
  const run = useCallback(async (work: (headers: Record<string, string>) => Promise<string | ((list: Client[]) => string)>) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setNote("");
    const token = getAuthToken();
    const fresh = () => alive.current && token === getAuthToken();
    const headers = { "X-MVHub-Tab": tab.current };
    try {
      const done = await work(headers);
      const list = await jsonFetch<{ clients: Client[] }>("/api/mcp/v2/app/clients", { headers });
      if (fresh()) { setClients(list.clients); setFailed(false); setNote(typeof done === "function" ? done(list.clients) : done); }
    } catch {
      if (fresh()) { setFailed(true); setNote("연결 상태를 확인하지 못했습니다. 이 PC 의 MV Hub 로그인을 확인한 뒤 다시 시도하세요."); }
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  }, []);

  useEffect(() => { void run(async () => ""); }, [run]);

  const liveOf = (list: Client[], app: AppKey) => list.filter((client) => client.name === app && !client.revoked_at);
  const active = (app: AppKey) => liveOf(clients ?? [], app);
  // '수동 등록 필요'는 연결 기록이 남아 있어도 그 앱 설정은 아직 안 쓴 상태다 — '연결됨'보다 앞세운다(Codex 리뷰 01a1e375 #2).
  //  서버 목록은 앱 설정이 실제로 끝났는지 모른다 — 그 앱이 MV Hub 에 접속해 응답한 기록(last_seen_at)이 있어야 '연결됨', 없으면 '등록됨'.
  //  그래서 창을 다시 열어 수동 등록 결과가 사라져도 '연결됨'이라 하지 않는다(Codex 리뷰 01a1e38d #2).
  const stateOf = (app: AppKey) => results[app]?.status === "manual" ? "manual"
    : active(app).length ? (active(app).some((client) => client.last_seen_at) ? "on" : "registered")
    : results[app]?.status ?? (clients === null ? (failed ? "unknown" : "loading") : "off");

  const connect = (apps: AppKey[]) => run(async (headers) => {
    const result = await jsonFetch<{ clients: Registration[] }>("/api/mcp/v2/app/configure", {
      method: "POST", headers, body: jsonBody({ clients: apps, scope: "account", allow_execution: true }),
    });
    setResults((previous) => ({ ...previous, ...Object.fromEntries(result.clients.map((row) => [row.client, row])) }));
    return result.clients.some((row) => row.status === "configured")
      ? "등록했습니다. 열려 있던 Codex·Claude 는 다시 켜야 MV Hub 가 보입니다."
      : "등록한 앱이 없습니다. 앱마다 이유를 확인하세요.";
  });

  // 해제는 화면에 남은 목록이 아니라 지금 목록으로 — 다시 등록으로 연결이 바뀐 뒤 목록 읽기가 실패했어도 새 연결까지 해제한다.
  //  해제 뒤 다시 읽은 목록에 그 앱의 살아 있는 연결이 없을 때만 '해제했습니다'(Codex 리뷰 01a1e375 #1).
  const revoke = (app: AppKey) => run(async (headers) => {
    const latest = await jsonFetch<{ clients: Client[] }>("/api/mcp/v2/app/clients", { headers });
    for (const client of liveOf(latest.clients, app)) {
      await jsonFetch(`/api/mcp/v2/app/clients/${encodeURIComponent(client.id)}/revoke`, { method: "POST", headers, body: "{}" });
    }
    setResults((previous) => ({ ...previous, [app]: undefined }));
    return (list: Client[]) => liveOf(list, app).length
      ? "해제하지 못한 연결이 남아 있습니다. 다시 해제하거나 연결 창(고급)에서 확인하세요."
      : "자료 조회와 생성 권한을 해제했습니다.";
  });

  // 수동 등록 — 서버가 쓰지 못한 설정을 복사해 그 앱에 직접 넣는다(MCP 창의 'MCP 설정 복사'와 같은 내용)
  const copyConfig = async (app: AppKey) => {
    const config = results[app]?.config;
    const text = typeof config === "string" ? config : JSON.stringify(config, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      setNote("설정을 복사했습니다. 그 앱의 MCP 설정에 붙여 넣은 뒤 앱을 다시 켜세요.");
    } catch {
      setNote("자동 복사를 쓸 수 없습니다. 연결 창(고급)에서 설정을 복사하세요.");
    }
  };

  // 제목 밑 줄 — 등록된 앱 이름. 모두 응답이 확인됐으면 '연결됨', 하나라도 확인 전이면 '등록됨'
  const linked = APPS.filter((app) => ["on", "registered"].includes(stateOf(app.key)));
  const allSeen = linked.every((app) => stateOf(app.key) === "on");
  const summary = clients === null ? "" : linked.length
    ? [t(allSeen ? "연결됨" : "등록됨"), ...linked.map((app) => app.label)].join(" · ") : t("연결 안 됨");
  useEffect(() => { onSummary?.(summary); }, [summary, onSummary]);

  return (
    <section className="settings-section mcp-quick">
      <h4>{t("MV·MCP 연결")}</h4>
      <p className="settings-lead">
        {t("내 PC 의 Codex·Claude 앱에서 MV Hub 자료를 쓰고 생성하게 합니다.")} <b>{t("MV Agent 칸은 이 연결 없이 씁니다.")}</b>
      </p>
      <div className="settings-install-list">
        {APPS.map((app) => {
          const state = stateOf(app.key);
          const [label, tone] = PILL[state] ?? PILL.off;
          const reason = state === "registered" ? "그 앱에서 아직 응답을 확인하지 못했습니다 — 앱을 다시 켜면 확인됩니다"
            : state !== "on" ? results[app.key]?.message : "";
          return (
            <div className="settings-install-row" key={app.key} data-app={app.key}>
              <div className="settings-install-text">
                <span className="settings-install-name">{app.label}</span>
                <span className="settings-install-sub">{reason ? t(reason) : t(app.sub)}</span>
              </div>
              <span className={`settings-pill is-${tone}`}>{t(label)}</span>
              {state === "on" || state === "registered" ? (
                <button type="button" className="settings-action settings-action-sm" disabled={busy} onClick={() => void revoke(app.key)}>{t("해제")}</button>
              ) : state === "manual" && results[app.key]?.config ? (
                <button type="button" className="settings-action settings-action-sm" disabled={busy} onClick={() => void copyConfig(app.key)}>{t("설정 복사")}</button>
              ) : state !== "loading" ? (
                <button type="button" className="settings-action settings-action-sm" disabled={busy} onClick={() => void connect([app.key])}>
                  {t(state === "off" ? "연결" : "다시 연결")}
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
      <div className="settings-row">
        <button type="button" className="settings-action settings-action-main" disabled={busy || (clients === null && !failed)}
          onClick={() => void connect(APPS.map((app) => app.key))}>
          {t(busy ? "처리 중" : "한 번에 연결")}
        </button>
      </div>
      {note && <p className="settings-hint" role="status">{t(note)}</p>}
      <p className="settings-hint">{t("이후 생성마다 승인을 묻지 않고, 요청한 생성은 크레딧을 씁니다. 이 PC 의 MV Hub 와 작업자가 켜져 있어야 합니다.")}</p>
      <details className="settings-adv">
        <summary>{t("다른 MCP 프로그램 설정 복사 · 고급")}</summary>
        <p>{t("다른 MCP 프로그램 설정, 저장된 연결 목록, MCP 업데이트, 캔버스 대기 작업은 연결 창에 있습니다.")}</p>
        <button type="button" className="settings-action" onClick={onOpenWindow}>{t("MV·MCP 연결 열기")}</button>
      </details>
    </section>
  );
}
