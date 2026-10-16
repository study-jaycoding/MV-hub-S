import { useEffect, useRef, useState } from "react";
import { api } from "../../api";
import type { Generation, WorkspaceContext } from "../../types";
import type { CanvasGenerationLink } from "../../lib/canvasGenerationRecovery";
import { errorDetail, getAuthToken, jsonBody, jsonFetch } from "../../lib/http";
import { useModalFocus } from "../../lib/keyGate";
import { useEscapeClose } from "../../lib/useEscapeClose";
import { useT } from "../../lib/i18n";
import { modelBlockMessage } from "../../lib/modelPolicy";
import { sameSceneContent } from "../../lib/sceneAbsorb";
import { confirmSceneWrite, listPersistedScenes, listScenes, type Scene } from "../../lib/scenes";
import { captureMcpContext, mcpProjects, prepareMcpPlan, sendMcpReply, summarizeMcpContext, versionMcpReferences, type McpContext, type McpReply } from "../../lib/mcpContext";
import { boundedText, executeMcpPlan, McpPreflightError, mcpFailureMessage, mcpDraftMatches, mcpPlanCards, mcpSceneHash, strictObject, type McpPlanRecord } from "../../lib/mcpPlans";
import "./mcp.css";
import { McpRegistration } from "./McpRegistration";

export interface McpConnectionProps {
  open: boolean;
  onClose: () => void;
  authReady: boolean;
  authKey: string;
  workspace: WorkspaceContext;
  activeSceneId: string | null;
  flushScenePending: (sceneId: string) => void;
  patchSceneById: (sceneId: string, patch: Partial<Scene>) => boolean;
  prepareCanvasGenerationBatch: (sceneId: string, cardIds: string[], links?: CanvasGenerationLink[]) => Promise<CanvasGenerationLink[]>;
  settleCanvasGeneration: (link: CanvasGenerationLink, generation: Generation) => void;
  discardCanvasGeneration: (link: CanvasGenerationLink) => void;
}
interface Connected {
  tab: string;
  key: string;
  token: string | null;
  name: string;
  canExecute: boolean;
}
interface BrokerRequest { id: string; method: string; args: Record<string, unknown> }
export interface McpSetup {
  url: string;
  adapter: string;
  adapter_exists: boolean;
  python: string | null;
  python_exists: boolean;
  python_args?: string[];
}

export function mcpSetupConfig(setup: McpSetup, client: "codex" | "claude"): string {
  if (!setup.adapter_exists || !setup.python || !setup.python_exists) return "";
  const args = [...(setup.python_args ?? []), setup.adapter, "--url", setup.url];
  return client === "codex"
    ? `[mcp_servers.mvhub]\ncommand = ${JSON.stringify(setup.python)}\nargs = ${JSON.stringify(args)}\ntool_timeout_sec = 150`
    : JSON.stringify({ mcpServers: { mvhub: { command: setup.python, args } } }, null, 2);
}

export function mcpInstallCommand(setup: McpSetup): string {
  if (!setup.adapter_exists || !setup.python) return "";
  const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
  const environment = setup.python.replace(/[\\/]Scripts[\\/]python\.exe$/, "");
  const requirements = setup.adapter.replace(/server\.py$/, "requirements.txt");
  return [
    'py -3 -c "import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)"',
    "if ($LASTEXITCODE -ne 0) { throw 'Python 3.11 이상과 Python Launcher가 필요합니다.' }",
    `if (Test-Path -LiteralPath ${quote(environment)}) { throw '기존 MCP 환경이 있습니다. 덮어쓰지 말고 설치 상태를 확인하세요.' }`,
    `py -3 -m venv ${quote(environment)}`,
    "if ($LASTEXITCODE -ne 0) { throw 'Python 환경 생성 실패' }",
    `& ${quote(setup.python)} -m pip install -r ${quote(requirements)}`,
    "if ($LASTEXITCODE -ne 0) { throw 'MCP 패키지 설치 실패' }",
  ].join("\n");
}

export function McpConnection(props: McpConnectionProps) {
  // 화면 글만 번역한다(Jay 2026-10-16). 상태·오류 글은 한국어 원문으로 두고 보일 때 t — LLM 응답·서버에 남는 글은 그대로.
  const t = useT();
  const [code, setCode] = useState("");
  const [connected, setConnected] = useState<Connected | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<McpPlanRecord | null>(null);
  const [requested, setRequested] = useState(false);
  const [projectNames, setProjectNames] = useState<Record<string, string>>({});
  const [setup, setSetup] = useState<McpSetup | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [client, setClient] = useState<"codex" | "claude">("codex");
  const [checking, setChecking] = useState(false);
  const [connectionNote, setConnectionNote] = useState("");
  const [copyNote, setCopyNote] = useState("");
  const checkingRef = useRef(false);
  const checkingAbort = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const context = useRef<McpContext | null>(null);
  const current = useRef(props);
  current.current = props;
  const connectionRef = useRef(connected);
  connectionRef.current = connected;
  const busyRef = useRef(false);
  const execution = useRef<{ plan_id: string; running: boolean; error: string | null } | null>(null);
  const modal = useRef<HTMLDivElement>(null);
  const visible = props.open || requested;
  const scopeKey = JSON.stringify([props.authKey, props.workspace, props.authReady]);
  const keyRef = useRef(scopeKey);
  keyRef.current = scopeKey;

  const closePanel = () => { if (!busyRef.current) { setRequested(false); props.onClose(); } };
  useModalFocus(modal, visible);
  useEscapeClose(closePanel, visible);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; checkingAbort.current?.abort(); }; }, []);

  async function checkConnection(showSetup = false) {
    if (checkingRef.current || busyRef.current) return;
    checkingRef.current = true; setChecking(true); setConnectionNote("");
    const abort = new AbortController();
    checkingAbort.current = abort;
    const timeout = window.setTimeout(() => abort.abort(), 10_000);
    if (showSetup) setSetupOpen(true);
    const key = keyRef.current, token = getAuthToken(), connection = connectionRef.current;
    const fresh = () => mounted.current && key === keyRef.current && token === getAuthToken() && connectionRef.current === connection;
    try {
      if (!current.current.authReady) throw new Error("로그인 상태를 확인한 뒤 연결하세요.");
      if (connection && !showSetup) {
        await call(connection, "/app/check", undefined, abort.signal);
        if (fresh()) setConnectionNote("연결된 앱 탭의 응답을 확인했습니다.");
      } else {
        const result = await jsonFetch<McpSetup>("/api/mcp/app/setup", { headers: { "X-MVHub-Tab": connection?.tab || crypto.randomUUID() }, signal: abort.signal });
        if (fresh()) {
          setSetup(result);
          setConnectionNote(connection ? "등록 정보를 확인했습니다." : "허브 응답 확인 · 아직 LLM과 연결되지 않았습니다.");
        }
      }
    } catch (failure) {
      if (fresh()) {
        setSetup(null);
        const incomplete = "MCP 번들이 불완전합니다. 앱을 다시 설치하세요.";
        setConnectionNote(errorDetail(failure) === incomplete ? incomplete : "연결을 확인하지 못했습니다. 이 PC의 MCP 지원 앱·로그인·LLM 등록 상태를 확인하세요.");
      }
    } finally {
      window.clearTimeout(timeout);
      checkingAbort.current = null;
      checkingRef.current = false;
      if (mounted.current) setChecking(false);
    }
  }

  async function copySetup(text: string) {
    try { await navigator.clipboard.writeText(text); if (mounted.current) setCopyNote("복사했습니다. 아래 안내에 따라 등록하세요."); }
    catch { if (mounted.current) setCopyNote("자동 복사를 사용할 수 없습니다. 아래 내용을 선택해서 복사하세요."); }
  }

  function assertConnection(connection: Connected): void {
    if (!current.current.authReady || keyRef.current !== connection.key || getAuthToken() !== connection.token || connectionRef.current !== connection) throw new Error("계정 또는 워크스페이스가 바뀌었습니다. AI 연결을 다시 허용하세요.");
  }
  async function call<T>(connection: Connected, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    assertConnection(connection);
    const result = await jsonFetch<T>(`/api/mcp${path}`, { ...(body === undefined ? {} : { method: "POST", body: jsonBody(body) }), headers: { "X-MVHub-Tab": connection.tab }, signal });
    assertConnection(connection);
    return result;
  }
  async function readScene(): Promise<Scene> {
    const id = current.current.activeSceneId;
    if (!id) throw new Error("MV Hub에서 사용할 캔버스를 먼저 여세요. 새 장면은 빈 캔버스를 만들면 됩니다.");
    const { confirmed } = confirmSceneWrite(() => current.current.flushScenePending(id));
    if (!await confirmed) throw new Error("캔버스 저장을 확인하지 못했습니다.");
    const working = listScenes(null).find((scene) => scene.id === id);
    const persisted = listPersistedScenes(null).find((scene) => scene.id === id);
    if (!working || !persisted || await mcpSceneHash(working) !== await mcpSceneHash(persisted)) throw new Error("캔버스의 최신 편집이 저장되지 않았습니다. 저장 후 다시 요청하세요.");
    if (current.current.activeSceneId !== id) throw new Error("활성 캔버스가 바뀌었습니다.");
    return JSON.parse(JSON.stringify(persisted)) as Scene;
  }

  async function handle(connection: Connected, request: BrokerRequest): Promise<object> {
    assertConnection(connection);
    if (request.method === "read_context") {
      const args = strictObject(request.args, ["kind", "project_id", "search", "limit"]);
      const limit = args.limit === undefined ? 50 : args.limit;
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("조회 개수는 1~50이어야 합니다.");
      if (args.kind === "scene") {
        if (busyRef.current) throw new Error("생성 실행 중에는 씬 문맥을 교체하지 않습니다. get_plan으로 상태를 확인하세요.");
        context.current = await captureMcpContext(await readScene(), current.current.workspace);
        assertConnection(connection);
        return summarizeMcpContext(context.current);
      }
      if (args.kind === "projects") {
        const projects = await mcpProjects(current.current.workspace);
        setProjectNames(Object.fromEntries(projects.map((item) => [item.id, item.name])));
        if (typeof args.project_id === "string") {
          if (!projects.some((item) => item.id === args.project_id)) throw new Error("현재 공간의 프로젝트를 지정하세요.");
          const folder = await api.projectFolder(args.project_id);
          return { project: projects.find((item) => item.id === args.project_id), folders: folder.tree, truncated: folder.truncated, error: folder.error };
        }
        return { projects: projects.slice(0, limit), has_more: projects.length > limit };
      }
      if (args.kind === "models") {
        const models = await api.models();
        // 옵션 스키마가 필요하므로 모델 ID로 좁힐 수 있다. 전 모델의 옵션을 무조건 읽지 않는다.
        const selected = typeof args.search === "string" ? models.filter((model) => model.job_set_type.includes(args.search as string) || model.display_name.includes(args.search as string)) : models;
        const items = await Promise.all(selected.slice(0, limit).map(async (model) => ({ ...model, params: (await api.modelParams(model.job_set_type)).params })));
        return { models: items, has_more: selected.length > limit };
      }
      if (args.kind === "generations") {
        const projectId = boundedText(args.project_id, 200, "프로젝트");
        if (!(await mcpProjects(current.current.workspace)).some((item) => item.id === projectId)) throw new Error("현재 공간의 프로젝트를 지정하세요.");
        const workspace = current.current.workspace;
        const items = await api.listGenerations({ tab: "my", project_id: projectId, search: typeof args.search === "string" ? args.search.slice(0, 300) : undefined, workspace_scope: workspace.scope === "personal" ? "personal" : undefined, workspace_ids: workspace.scope === "team" && workspace.id ? [workspace.id] : undefined }, null, limit);
        return { generations: items.map((item) => ({ id: item.id, prompt: item.display_prompt || item.prompt, model: item.model, status: item.status, project_id: item.project_id, folder_path: item.folder_path })), has_more: items.length === limit };
      }
      throw new Error("kind는 scene, projects, generations, models 중 하나여야 합니다.");
    }
    if (request.method === "prepare_generation_plan") {
      if (busyRef.current) throw new Error("생성 요청 처리 중에는 새 계획을 받지 않습니다.");
      const snapshot = context.current;
      if (!snapshot) throw new Error("read_context(kind=scene)부터 호출하세요.");
      const body = await prepareMcpPlan(request.args, snapshot, await readScene(), current.current.workspace);
      assertConnection(connection);
      if (context.current !== snapshot || await mcpSceneHash(await readScene()) !== body.scene_hash) throw new Error("계획 작성 중 캔버스가 바뀌었습니다. 다시 읽어 주세요.");
      const result = await call<McpPlanRecord>(connection, "/plans", body);
      const projects = await mcpProjects(current.current.workspace);
      assertConnection(connection);
      setProjectNames(Object.fromEntries(projects.map((item) => [item.id, item.name])));
      setPlan(result);
      return { plan_id: result.id, status: result.status, revision: result.revision, items: body.items.map((item) => ({ label: item.label, estimated_credits: item.estimated_credits })), estimated_credits: body.items.reduce((sum, item) => sum + item.estimated_credits, 0), execution: "아직 생성하지 않았습니다. 명확한 사용자 생성 요청이 있으면 execute_generation_plan을 호출하세요." };
    }
    if (["get_plan", "request_execution", "execute_generation_plan"].includes(request.method)) {
      const args = strictObject(request.args, ["plan_id"]);
      const id = boundedText(args.plan_id, 100, "계획 ID");
      const result = await call<McpPlanRecord>(connection, `/plans/${encodeURIComponent(id)}`);
      if (request.method === "execute_generation_plan") {
        if (!connection.canExecute) throw new Error("앱에서 연결을 해제하고 실행 허용으로 다시 연결하세요.");
        if (busyRef.current || result.status !== "proposed" || execution.current?.plan_id === id) throw new Error("실행을 반복하지 말고 get_plan으로 기존 요청 상태를 확인하세요.");
        setPlan(result);
        setRequested(true);
        // 제출을 기다리면 long poll이 멈추고 연결이 만료된다.
        void runPlan(result, connection, "mcp");
        return { plan_id: id, status: "execution_started", submitted: false, next: "get_plan으로 실행 오류와 항목별 접수·생성 상태를 확인하세요." };
      }
      if (request.method === "request_execution") {
        if (busyRef.current) throw new Error("생성 요청을 처리 중입니다.");
        setPlan(result);
        setRequested(true);
        return { plan_id: id, status: "awaiting_user_approval", submitted: false };
      }
      const items = await Promise.all(result.items.map(async (item, index) => {
        const generationId = result.plan.items[index].request.canvas_link.generation_id;
        let generationStatus: string | null = null;
        if (["submitting", "submitted", "uncertain"].includes(item.state)) {
          try { generationStatus = (await api.getGeneration(generationId)).status; } catch { /* 접수 여부가 불명확하면 그대로 둔다. */ }
        }
        return { ...item, label: result.plan.items[index].label, generation_id: generationId, generation_status: generationStatus };
      }));
      return { plan_id: result.id, status: result.status, revision: result.revision, approved_at: result.approved_at, items, execution: execution.current?.plan_id === id ? { ...execution.current } : null };
    }
    throw new Error("지원하지 않는 MCP 명령입니다.");
  }

  useEffect(() => {
    checkingAbort.current?.abort();
    setSetup(null); setConnectionNote(""); setCopyNote("");
  }, [scopeKey]);

  useEffect(() => {
    if (!connected) return;
    const abort = new AbortController();
    let live = true;
    const run = async () => {
      try {
        while (live) {
          const response = await call<{ request: BrokerRequest | null }>(connected, "/app/next", undefined, abort.signal);
          if (!response.request) continue;
          const request = response.request;
          let reply: McpReply;
          try { reply = { id: request.id, result: await handle(connected, request) }; }
          catch (failure) { reply = { id: request.id, error: errorDetail(failure).slice(0, 400) }; }
          if (live) await sendMcpReply(reply, (body) => call(connected, "/app/reply", body, abort.signal));
        }
      } catch (failure) {
        if (live) { setError(errorDetail(failure)); setConnected(null); context.current = null; }
      }
    };
    void run();
    return () => {
      live = false;
      abort.abort();
      // 탭 소유권만 폐기한다. 이미 제출된 생성 작업은 취소하지 않는다.
      void jsonFetch("/api/mcp/app/close", { method: "POST", headers: { "X-MVHub-Tab": connected.tab }, body: "{}" }).catch(() => {});
    };
    // 요청은 current ref로 최신 선택을 확인한다. 렌더마다 long poll을 재시작하지 않는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  useEffect(() => {
    if (connected && connected.key !== scopeKey) {
      connectionRef.current = null;
      context.current = null;
      setConnected(null);
      setPlan(null);
      setError("계정 또는 워크스페이스 변경으로 AI 연결을 해제했습니다.");
    }
  }, [scopeKey, connected]);

  async function pair() {
    if (busyRef.current || checkingRef.current || !/^\d{6}$/.test(code)) return;
    busyRef.current = true; setBusy(true); setError("");
    const next: Connected = { tab: crypto.randomUUID(), key: keyRef.current, token: getAuthToken(), name: "", canExecute: false };
    try {
      if (!current.current.authReady) throw new Error("로그인 상태를 확인한 뒤 연결하세요.");
      const result = await jsonFetch<{ name: string; client_id: string; can_execute?: boolean }>("/api/mcp/app/pair", { method: "POST", headers: { "X-MVHub-Tab": next.tab }, body: jsonBody({ pair_code: code, allow_execution: true }) });
      if (next.key !== keyRef.current || next.token !== getAuthToken()) throw new Error("연결 중 계정이 변경되었습니다. 다시 연결하세요.");
      next.name = result.name;
      next.canExecute = result.can_execute === true;
      connectionRef.current = next;
      setConnected(next); setCode(""); context.current = null; execution.current = null;
      setConnectionNote(""); setCopyNote("");
    } catch (failure) { setError(errorDetail(failure)); }
    finally { busyRef.current = false; setBusy(false); }
  }

  async function runPlan(initial: McpPlanRecord, connection: Connected, source: "app" | "mcp") {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError("");
    const observation = { plan_id: initial.id, running: true, error: null as string | null };
    execution.current = observation;
    let submissionAttempted = false;
    try {
      await executeMcpPlan(initial, {
        check: async () => {
          await call(connection, "/app/check");
          if (!context.current || context.current.id !== initial.plan.context_id || await mcpSceneHash(await readScene()) !== initial.plan.scene_hash) throw new Error("계획 작성 뒤 캔버스가 바뀌었거나 연결이 새로 시작되었습니다. 새 계획이 필요합니다.");
          for (const item of initial.plan.items) {
            const block = modelBlockMessage(item.request.create.model);
            if (block) throw new Error(block);
            const verified = await versionMcpReferences(item.reference_snapshot);
            if (JSON.stringify(verified) !== JSON.stringify(item.reference_snapshot)) throw new Error("참고 자료의 버전이 바뀌었습니다. 다시 계획하세요.");
          }
          assertConnection(connection);
        },
        approve: (record) => call(connection, `/plans/${record.id}/approve`, { revision: record.revision, source }),
        persistCards: async (body) => {
          assertConnection(connection);
          const scene = await readScene();
          if (await mcpSceneHash(scene) !== body.scene_hash) throw new Error("캔버스가 바뀌었습니다.");
          const patch = mcpPlanCards(body, scene);
          assertConnection(connection);
          const latest = listScenes(null).find((candidate) => candidate.id === scene.id);
          if (!latest || current.current.activeSceneId !== scene.id || !sameSceneContent(latest, scene)) throw new Error("카드를 준비하는 동안 캔버스가 바뀌었습니다.");
          const { value, confirmed } = confirmSceneWrite(() => current.current.patchSceneById(scene.id, patch));
          if (!value || !await confirmed) throw new Error("계획 카드를 저장하지 못해 생성을 중단했습니다.");
          const stored = listPersistedScenes(null).find((candidate) => candidate.id === scene.id);
          if (!stored || await mcpSceneHash(stored) !== await mcpSceneHash({ ...scene, ...patch })) throw new Error("계획 카드 저장 내용이 달라 생성을 중단했습니다.");
        },
        persistLinks: async (body) => {
          assertConnection(connection);
          if (!mcpDraftMatches(body, await readScene())) throw new Error("승인한 카드가 수정되거나 삭제되어 제출을 중단했습니다.");
          const links = body.items.map((item) => item.request.canvas_link);
          const result = await current.current.prepareCanvasGenerationBatch(body.scene_id, links.map((link) => link.card_id), links);
          if (result.length !== links.length) throw new Error("생성 연결을 저장하지 못해 제출을 중단했습니다.");
        },
        state: (record, index, state, error) => call(connection, `/plans/${record.id}/item`, { revision: record.revision, index, state, ...(error ? { error } : {}) }),
        submit: async (item) => {
          assertConnection(connection);
          let phase: "scene" | "references" | "cost" | "policy" = "scene";
          try {
            if (current.current.activeSceneId !== initial.plan.scene_id) throw new Error("선택한 캔버스가 바뀌어 제출을 중단했습니다.");
            if (!mcpDraftMatches(initial.plan, await readScene())) throw new Error("승인한 카드가 수정되거나 삭제되어 제출을 중단했습니다.");
            phase = "references";
            if (JSON.stringify(await versionMcpReferences(item.reference_snapshot)) !== JSON.stringify(item.reference_snapshot)) throw new Error("참고 자료 버전이 바뀌어 제출을 중단했습니다.");
            const body = item.request.create;
            phase = "cost";
            const cost = await api.estimateCost(body.model, body.params || {}, body.prompt);
            if (typeof cost.credits !== "number" || !Number.isFinite(cost.credits) || cost.credits < 0 || cost.credits > item.estimated_credits) throw new Error("예상 크레딧이 바뀌었거나 확인할 수 없어 제출을 중단했습니다. 새 계획이 필요합니다.");
            phase = "policy";
            const block = modelBlockMessage(body.model);
            if (block) throw new Error(block);
          } catch {
            // 아직 생성 API를 호출하지 않은 로컬 사전 확인 실패다.
            throw new McpPreflightError(phase);
          }
          assertConnection(connection);
          if (current.current.activeSceneId !== initial.plan.scene_id) throw new McpPreflightError("scene");
          current.current.flushScenePending(initial.plan.scene_id);
          const latest = listScenes(null).find((candidate) => candidate.id === initial.plan.scene_id);
          if (!latest || !mcpDraftMatches(initial.plan, latest)) throw new McpPreflightError("scene");
          submissionAttempted = true;
          const generation = await api.prepareCreate(item.request.create, item.request.workspace, item.request.canvas_link)();
          assertConnection(connection);
          current.current.settleCanvasGeneration(item.request.canvas_link, generation);
        },
        discard: (item) => { assertConnection(connection); current.current.discardCanvasGeneration(item.request.canvas_link); },
        changed: (record) => setPlan(record),
      });
    } catch (failure) {
      observation.error = submissionAttempted ? mcpFailureMessage(failure) : "이 실행은 생성 요청 API 호출 전에 중단되었습니다. 앱의 오류와 계획·연결 상태를 확인하세요. 자동 재제출하지 않습니다.";
      setError(errorDetail(failure));
    }
    finally { observation.running = false; busyRef.current = false; setBusy(false); }
  }

  if (!visible) return null;
  return <div className="mcp-backdrop">
    <div className="mcp-dialog" ref={modal} role="dialog" aria-modal="true" aria-label={t("MV·MCP 연결")}>
      {/* 제목·✕ 는 설정 창과 같은 머리(Jay 2026-10-16 모의 그림) */}
      <div className="mcp-heading"><h2>{t("MV·MCP 연결")}</h2><button className="mcp-close" onClick={closePanel} disabled={busy} aria-label={t("닫기")}>✕</button></div>
      <McpRegistration authReady={props.authReady} authKey={props.authKey} workspace={props.workspace} />
      <details className="mcp-legacy"><summary>{t("이전 방식 연결 · 고급 호환 설정")}</summary>
      <p>{t("아래 6자리 코드 방식은 이전 클라이언트용입니다. 이 방식은 연결한 브라우저 창을 열어 두어야 합니다.")}</p>
      <p>{t("현재 공간:")} <strong>{props.workspace.name || t(props.workspace.scope === "personal" ? "개인 공간" : "선택 확인 필요")}</strong> · {connected ? `${t("LLM 연결됨")} · ${t(connected.canExecute ? "생성 실행 허용" : "조회·수동 생성만 허용")}` : t("LLM 연결 안 됨")}</p>
      <div className="mcp-actions">
        <button disabled={busy || checking || !props.authReady} onClick={() => void checkConnection(true)} aria-expanded={setupOpen} aria-controls="mcp-setup-guide">{t("처음 연결 설정")}</button>
        <button disabled={busy || checking || !props.authReady} onClick={() => void checkConnection()}>{t(checking ? "확인 중…" : "연결 상태 확인")}</button>
      </div>
      {connectionNote && <p role="status">{t(connectionNote)}</p>}
      {setupOpen && <section id="mcp-setup-guide" className="mcp-setup">
        <h3>{t("1. LLM 프로그램에 한 번 등록")}</h3>
        <p>{t("같은 PC의 Codex 또는 Claude Code·Desktop용입니다. 웹·휴대폰 LLM의 원격 커넥터 주소로는 사용할 수 없습니다.")}</p>
        {!setup ? <p>{t("처음 연결 설정을 눌러 현재 허브의 등록 정보를 확인하세요.")}</p> : <>
          <p>{t("허브 주소:")} <code>{setup.url}</code></p>
          {!setup.adapter_exists ? <p className="mcp-error">{t("이 앱 폴더에는 MCP 어댑터가 없습니다. MCP가 포함된 개발 버전에서 연결하세요.")}</p> : !setup.python_exists ? <>
            <p>{t("MCP 실행 환경을 먼저 설치해야 합니다. Python 3.11 이상이 필요합니다. 설치 후 연결 상태를 다시 확인하세요.")}</p>
            {setup.python ? <><button onClick={() => void copySetup(mcpInstallCommand(setup))}>{t("PowerShell 설치 명령 복사")}</button><pre>{mcpInstallCommand(setup)}</pre></> : <p>{t("Windows 사용자 환경 경로를 확인하지 못했습니다. 로컬 앱 실행 환경을 확인하세요.")}</p>}
          </> : <>
            <label>{t("사용할 프로그램")} <select value={client} onChange={(event) => { setClient(event.target.value as "codex" | "claude"); setCopyNote(""); }}><option value="codex">Codex</option><option value="claude">Claude Code · Desktop</option></select></label>
            <p>{t(client === "codex" ? "사용자 .codex\\config.toml에 아래 mvhub 항목을 추가하세요." : "Claude Code는 사용자 .claude.json, Claude Desktop은 claude_desktop_config.json의 mcpServers에 mvhub 항목을 추가하세요.")} {t("기존 설정 전체를 덮어쓰지 말고, mvhub가 이미 있으면 주소와 경로를 비교하세요.")}</p>
            <button onClick={() => void copySetup(mcpSetupConfig(setup, client))}>{t("등록 설정 복사")}</button>
            <pre>{mcpSetupConfig(setup, client)}</pre>
            <p>{t("실행 파일 존재만 확인했습니다. 패키지 설치·LLM 등록 성공은 아직 확인하지 않았습니다.")}</p>
          </>}
        </>}
        {copyNote && <p role="status">{t(copyNote)}</p>}
        <h3>{t("2. LLM에서 연결 요청")}</h3>
        <p>{t("설정을 저장한 뒤 LLM 프로그램의 MCP를 다시 불러오고 “MV Hub에 연결해 줘”라고 요청하세요. LLM이 표시하는 6자리 코드를 아래에 입력합니다.")}</p>
        <p>{t("연결 후에는 “이 컷에 이미지 생성해”라고 요청하면 됩니다. 앱을 닫거나 계정·공간을 바꾸면 다시 연결해야 합니다.")}</p>
        <button onClick={() => setSetupOpen(false)}>{t("등록 안내 접기")}</button>
      </section>}
      {connected ? <p><strong>{connected.name || t("AI 도구")}</strong> {t("연결됨")} · {props.workspace.name || t("개인 공간")} <button disabled={busy} onClick={() => { connectionRef.current = null; setConnected(null); context.current = null; setPlan(null); }}>{t("연결 해제")}</button></p> : <div className="mcp-pair"><label>{t("AI 도구에 표시된 6자리 연결 코드")}<input inputMode="numeric" autoComplete="off" value={code} maxLength={6} onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))} /></label><button disabled={busy || !props.authReady || !/^\d{6}$/.test(code)} onClick={() => void pair()}>{t("연결 허용")}</button></div>}
      {error && <p role="alert" className="mcp-error">{t(error)}</p>}
      {plan && <section>
        <h3>{plan.plan.title}</h3>
        <p>{t("과금 공간:")} <strong>{plan.plan.workspace.name || t("개인 공간")}</strong> ({plan.plan.workspace.id || "personal"})<br />{t("생성 {n}건 · 예상 {credits} 크레딧").replace("{n}", String(plan.plan.items.length)).replace("{credits}", String(plan.plan.items.reduce((sum, item) => sum + item.estimated_credits, 0)))}</p>
        <p>{t("견적은 실제 과금 보장이 아닙니다. 승인 후 앱을 닫아도 이미 제출한 작업은 계속됩니다.")}</p>
        <ol className="mcp-items">{plan.plan.items.map((item, index) => <li key={item.request.canvas_link.attempt_id}>
          <strong>{item.label}</strong> · {item.request.create.model} · {item.estimated_credits} {t("크레딧")}
          <p>{t("프로젝트:")} {projectNames[item.request.create.project_id || ""] || t("이름 미확인")} ({item.request.create.project_id}) / {t("컷:")} {item.request.create.folder_path}</p>
          <pre>{item.request.create.display_prompt || item.request.create.prompt}</pre>
          <pre>{JSON.stringify(item.request.create.params || {}, null, 2)}</pre>
          <p>{t("자료:")} {item.reference_snapshot.length ? item.reference_snapshot.map((ref) => `${ref.name || t("자료")} [${ref.asset_version || t(ref.source_version ? "원본 생성물 확인" : "버전 미확인")}]`).join(", ") : t("없음")}</p>
          <p>{t("요청 상태:")} {plan.items[index]?.state === "submitted" ? t("접수 완료 (영상 완료 여부는 생성 카드에서 확인)") : plan.items[index]?.state} · {t("결과 ID:")} {item.request.canvas_link.generation_id}</p>
          {plan.items[index]?.error && <p className="mcp-error">{t(plan.items[index].error)}</p>}
        </li>)}</ol>
        <button className="mcp-approve" disabled={busy || !connected || plan.status !== "proposed"} onClick={() => { if (connected) void runPlan(plan, connected, "app"); }}>{t(busy ? "처리 중…" : "앱에서 직접 생성")}</button>
        {plan.status !== "proposed" && <p>{t("승인한 계획은 다시 실행하지 않습니다. 저장 실패·문맥 변경으로 제출하지 못한 항목도 자동 재시도하지 않습니다. 생성 카드와 작업 상태에서 기존 요청을 먼저 확인하고, 미제출이 확인된 항목만 새 계획으로 요청하세요.")}</p>}
      </section>}
      </details>
    </div>
  </div>;
}
