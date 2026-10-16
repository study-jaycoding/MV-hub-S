import { useEffect, useRef, useState } from "react";
import type { WorkspaceContext } from "../../types";
import { getAuthToken, HttpError, jsonBody, jsonFetch } from "../../lib/http";
import type { McpCanvasTask } from "../../lib/mcpCanvasTasks";
import { SettingsDescription } from "../settings/SettingsDescription";

// 상태 줄은 첫 문장만 굵게 — 결과, 그 뒤는 덧붙인 설명(Jay 2026-10-16 모의 그림)
function leadBold(text: string) {
  const cut = text.indexOf(". ") + 1;
  return cut > 0 ? <><strong>{text.slice(0, cut)}</strong>{text.slice(cut)}</> : <strong>{text}</strong>;
}

interface Client {
  id: string; name: string; scope?: "account" | "workspace"; workspace: WorkspaceContext | { scope: "account" } | null; can_execute: boolean;
  last_seen_at: string | null; revoked_at: string | null;
}
interface Registration {
  client: string; status: "configured" | "manual" | "error"; message: string; config?: unknown;
}

export function McpRegistration({ authReady, authKey, workspace }: { authReady: boolean; authKey: string; workspace: WorkspaceContext }) {
  const [clients, setClients] = useState<Client[]>([]);
  const [results, setResults] = useState<Registration[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [tasks, setTasks] = useState<McpCanvasTask[]>([]);
  const [taskNote, setTaskNote] = useState("");
  const tab = useRef(crypto.randomUUID());
  const pending = useRef(false);
  const active = useRef(true);
  const scope = JSON.stringify([authReady, authKey]);
  const scopeRef = useRef(scope); scopeRef.current = scope;
  const taskScope = JSON.stringify([scope, workspace.scope, workspace.id]);
  const taskScopeRef = useRef(taskScope);
  const taskEpoch = useRef(0);
  if (taskScopeRef.current !== taskScope) { taskScopeRef.current = taskScope; taskEpoch.current += 1; }
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => { setClients([]); setResults([]); setNote(""); }, [scope]);
  useEffect(() => { setTasks([]); setTaskNote(""); }, [taskScope]);

  async function requestTasks(cancelId?: string) {
    if (pending.current || !authReady || workspace.scope === "unknown") return;
    pending.current = true; setBusy(true); setTaskNote("");
    const epoch = taskEpoch.current, token = getAuthToken();
    const fresh = () => active.current && epoch === taskEpoch.current && token === getAuthToken();
    const headers = { "X-MVHub-Tab": tab.current };
    let alreadyFinished = false;
    try {
      if (cancelId) {
        try {
          await jsonFetch(`/api/mcp/v2/app/canvas-tasks/${encodeURIComponent(cancelId)}/cancel`, { method: "POST", headers, body: jsonBody({ workspace }) });
        } catch (error) {
          if (!(error instanceof HttpError) || error.status !== 404) throw error;
          alreadyFinished = true;
        }
        if (!fresh()) return;
      }
      const query = new URLSearchParams({ workspace_scope: workspace.scope });
      if (workspace.id) query.set("workspace_id", workspace.id);
      const result = await jsonFetch<{ tasks: McpCanvasTask[] }>(`/api/mcp/v2/app/canvas-tasks?${query}`, { headers });
      if (fresh()) {
        setTasks(result.tasks);
        setTaskNote(alreadyFinished ? "이 요청은 더 이상 대기 중이 아닙니다. 목록을 갱신했습니다." : cancelId ? "대기 요청을 취소했습니다. 이미 처리 중인 카드는 추가될 수 있습니다." : result.tasks.length ? "현재 공간의 대기 요청입니다." : "현재 공간에 대기 요청이 없습니다.");
      }
    } catch {
      if (fresh()) setTaskNote(cancelId ? "취소 결과를 확인하지 못했습니다. 대기 작업을 다시 확인하세요." : "대기 작업을 불러오지 못했습니다. 다시 확인하세요.");
    } finally { pending.current = false; if (active.current) setBusy(false); }
  }

  async function request(action: "list" | "configure" | "revoke", value?: string[] | string) {
    if (pending.current || !authReady) return;
    pending.current = true; setBusy(true); setNote("");
    const key = scopeRef.current, token = getAuthToken();
    const fresh = () => active.current && key === scopeRef.current && token === getAuthToken();
    const headers = { "X-MVHub-Tab": tab.current };
    try {
      if (action === "configure") {
        const result = await jsonFetch<{ clients: Registration[] }>("/api/mcp/v2/app/configure", { method: "POST", headers, body: jsonBody({ clients: value, scope: "account", allow_execution: true }) });
        if (!fresh()) return;
        setResults(result.clients);
      } else if (action === "revoke") {
        await jsonFetch(`/api/mcp/v2/app/clients/${encodeURIComponent(String(value))}/revoke`, { method: "POST", headers, body: "{}" });
        if (!fresh()) return;
      }
      const result = await jsonFetch<{ clients: Client[] }>("/api/mcp/v2/app/clients", { headers });
      if (fresh()) { setClients(result.clients); setNote(action === "revoke" ? "자료 조회와 생성 실행 권한을 해제했습니다." : "저장된 연결을 확인했습니다. 등록 완료와 실제 LLM 응답은 다릅니다."); }
    } catch {
      if (fresh()) setNote("처리 결과를 확인하지 못했습니다. 연결 목록을 다시 확인하세요. 프로그램 등록은 일부만 반영됐을 수 있습니다.");
    } finally { pending.current = false; if (active.current) setBusy(false); }
  }

  async function copy(text: string) {
    const key = scopeRef.current;
    try { await navigator.clipboard.writeText(text); if (active.current && key === scopeRef.current) setNote("설정을 복사했습니다. 사용하는 MCP 클라이언트에 등록하세요."); }
    catch { if (active.current && key === scopeRef.current) setNote("자동 복사를 사용할 수 없습니다. 아래 설정을 선택해서 복사하세요."); }
  }
  const disabled = busy || !authReady;
  // 모양은 설정 패널 규칙(Jay 2026-10-16 모의 그림): 작은 제목 · 회색 안내 · 라임 동의 칸 + 주 단추 · 보조(ghost) 단추 둘 ·
  // 긴 안내는 한 줄 요약 + 더보기(SettingsDescription 그대로). 단추 글자·순서·동작은 그대로(시험이 글자로 누른다).
  return <section className="mcp-reg" aria-label="계속 사용하는 MCP 연결">
    <h3 className="mcp-reg-title">LLM 프로그램 연결</h3>
    <p className="mcp-reg-lead">한 번 연결하면 Codex·Claude Code에서 MV Hub의 자료를 조회하고 생성할 수 있습니다.</p>
    <div className="mcp-reg-consent">
      <p>현재 계정이 접근 가능한 모든 공간의 자료 조회와 사용자 요청에 따른 크레딧 사용을 허용합니다. 이후 생성마다 앱 승인을 누르지 않습니다.</p>
      <button className="mcp-primary" disabled={disabled} onClick={() => void request("configure", ["codex", "claude"])}>Codex·Claude Code 연결 허용</button>
    </div>
    <div className="mcp-actions mcp-reg-secondary">
      <button disabled={disabled} onClick={() => void request("configure", ["other"])}>다른 MCP 프로그램 설정</button>
      <button disabled={disabled} onClick={() => void request("list")}>저장된 연결 확인</button>
    </div>
    <SettingsDescription summary="브라우저 창을 닫아도 생성됩니다. 이 PC의 MV Hub 서버와 작업자는 켜져 있어야 합니다.">
      <ul className="mcp-reg-notes">
        {/* 요약은 좁은 창에서 말줄임이 된다 — 켜 둘 것의 조건은 펼친 안내에도 둔다(Codex 10-16 P2) */}
        <li>브라우저 창은 닫아도 되지만, 이 PC의 MV Hub 서버와 작업자는 켜져 있어야 생성됩니다.</li>
        <li>사용할 워크스페이스·폴더·장면은 LLM에 말해 주세요. 앱에서 고른 공간과 관계없이 요청한 곳에 생성합니다.</li>
        <li>생성물과 기록은 MV Hub에 저장하고, 결과 미리보기는 지원하는 LLM 대화창에서도 봅니다. 캔버스에는 요청한 경우에만 추가합니다.</li>
        <li>처음 등록한 뒤에는 LLM 프로그램의 MCP 다시 불러오기·재시작이 필요할 수 있습니다. Claude Desktop 등 다른 로컬 앱은 ‘다른 MCP 프로그램 설정’을 쓰세요.</li>
        <li>이전의 공간 고정 연결은 위 버튼으로 다시 등록하면 계정 기준 연결로 바뀝니다.</li>
      </ul>
    </SettingsDescription>
    {note && <p className="mcp-reg-status" role="status">{leadBold(note)}</p>}
    {results.map((result, index) => {
      const config = result.config ? (typeof result.config === "string" ? result.config : JSON.stringify(result.config, null, 2)) : "";
      return <div className="mcp-result" data-status={result.status} key={`${result.client}:${index}`}>
        <strong>{result.client} · {result.status === "configured" ? "등록 완료" : result.status === "manual" ? "수동 등록 필요" : "등록 실패"}</strong>
        <p>{result.message}</p>
        {config && <><button onClick={() => void copy(config)}>MCP 설정 복사</button><pre>{config}</pre></>}
      </div>;
    })}
    <ul className="mcp-clients">{clients.map((client) => <li key={client.id}>
      <div className="mcp-client-info">
        <strong>{client.name}</strong>
        <span>{client.scope === "account" || client.workspace?.scope === "account" ? "계정 기준 연결" : `공간 고정: ${client.workspace?.name || client.workspace?.id || "개인 공간"}`}</span>
        <span>{client.revoked_at ? "권한 해제됨" : client.last_seen_at ? `최근 연결 확인: ${client.last_seen_at}` : "등록됨 · LLM 응답 미확인"}</span>
        {!client.revoked_at && <span>{client.can_execute ? "생성 허용" : "조회만 허용"}</span>}
      </div>
      {!client.revoked_at && <button className="mcp-revoke" disabled={disabled} onClick={() => void request("revoke", client.id)}>권한 해제</button>}
    </li>)}</ul>
    <details className="mcp-legacy">
      <summary>캔버스 대기 작업</summary>
      <p>대기 중인 추가 요청만 취소합니다. 이미 추가됐거나 처리 중인 카드는 삭제하지 않습니다.</p>
      <p>취소 후 LLM에 다시 추가를 요청할 수 있습니다. 이미 붙은 카드가 있으면 중복될 수 있으니 먼저 캔버스를 확인하세요.</p>
      <button disabled={disabled || workspace.scope === "unknown"} onClick={() => void requestTasks()}>대기 작업 확인</button>
      {taskNote && <p role="status">{taskNote}</p>}
      <ul className="mcp-clients">{tasks.map((task) => <li key={task.id}>
        <span>장면 {task.scene_id} · 생성물 {task.generation_ids.length}개</span>
        <button disabled={disabled} onClick={() => void requestTasks(task.id)}>추가 요청 취소</button>
      </li>)}</ul>
    </details>
  </section>;
}
