import { useEffect, useRef, useState } from "react";
import { api } from "../../api";
import type { Project } from "../../types";
import { assertSceneKeepScope, defaultSceneKeepProject, sceneKeepApi, sceneKeepErrorMessage, type SceneKeepPayload, type SceneKeepWorkspace } from "../../lib/sceneKeep";
import { useModalFocus } from "../../lib/keyGate";
import { useEscapeClose } from "../../lib/useEscapeClose";

export function SceneKeepDialog({ scope, name: initialName, projectId: initialProjectId, projects, workspace, selectedProjectId, capture, onSaved, onClose }: {
  scope: string; name: string; projectId: string; projects: Project[];
  workspace?: SceneKeepWorkspace | null; selectedProjectId?: string | null;
  capture: (name: string, project: Project | null) => SceneKeepPayload;
  onSaved: (name: string, missing: number) => void; onClose: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [projectId, setProjectId] = useState(initialProjectId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [overwrite, setOverwrite] = useState<{ payload: SceneKeepPayload; id: string; revision: number } | null>(null);
  const [retryPayload, setRetryPayload] = useState<SceneKeepPayload | null>(null);
  const projectSource = `${scope}:${workspace?.id ?? ""}`;
  const [loadedProjects, setLoadedProjects] = useState<{ source: string; items: Project[]; failed: boolean } | null>(null);
  const projectsLoading = !!workspace?.id && loadedProjects?.source !== projectSource;
  const projectsFailed = !!workspace?.id && loadedProjects?.source === projectSource && loadedProjects.failed;
  const availableProjects = workspace?.id ? (loadedProjects?.source === projectSource ? loadedProjects.items : []) : projects;
  useEffect(() => {
    if (!workspace?.id) return;
    let active = true;
    setError("");
    void (async () => {
      try {
        assertSceneKeepScope(scope);
        const result = await api.projects("my", false, workspace.id);
        if (!active) return;
        assertSceneKeepScope(scope);
        const items = result.projects.filter(project => !project.archived && project.workspace_id === workspace.id);
        setLoadedProjects({ source: projectSource, items, failed: false });
        setProjectId(defaultSceneKeepProject({ workspace }, items, selectedProjectId)?.id ?? "");
      } catch {
        if (active) setLoadedProjects({ source: projectSource, items: [], failed: true });
      }
    })();
    return () => { active = false; };
  }, [scope, workspace, projectSource, selectedProjectId]);
  const ref = useRef<HTMLDivElement>(null);
  const submitting = useRef(false);
  useModalFocus(ref);
  useEscapeClose(() => { if (!busy) { if (overwrite) setOverwrite(null); else onClose(); } });
  async function save() {
    if (submitting.current || projectsLoading || projectsFailed) return;
    submitting.current = true; setBusy(true); setError("");
    try {
      assertSceneKeepScope(scope);
      const payload = overwrite?.payload ?? retryPayload ?? capture(name, availableProjects.find(p => p.id === projectId) ?? null);
      const result = await sceneKeepApi.save(scope, overwrite ? { ...payload, overwrite_id: overwrite.id, overwrite_revision: overwrite.revision } : payload);
      assertSceneKeepScope(scope);
      if (result.status === "saved") { onSaved(payload.name, result.missing_count); onClose(); }
      else if (result.status === "exists") setOverwrite({ payload, id: result.id, revision: result.revision });
      else {
        // 충돌 뒤에는 읽기만 한다. 새 보관본이 있으면 다시 덮어쓰기 확인을 받고,
        // 사라졌으면 다음 보관 클릭까지 같은 사본을 보존한다.
        const latest = (await sceneKeepApi.list(scope)).find(row => row.project_id === payload.project_id && row.name === payload.name);
        assertSceneKeepScope(scope);
        setRetryPayload(payload);
        setOverwrite(latest ? { payload, id: latest.id, revision: latest.revision } : null);
        setError("보관본이 바뀌었습니다. 다시 확인해 주세요.");
      }
    } catch (e) { setError(sceneKeepErrorMessage(e, "보관하지 못했습니다.")); }
    finally { submitting.current = false; setBusy(false); }
  }
  return <div className="admin-confirm-backdrop" onMouseDown={() => { if (!busy) onClose(); }}>
    <div ref={ref} className="admin-confirm scene-keep-dialog" role="dialog" aria-modal="true" aria-label={overwrite ? "같은 이름이 있습니다" : "워크스페이스 보관"} onMouseDown={e => e.stopPropagation()}>
      <h2 className="admin-confirm-q">{overwrite ? "같은 이름이 있습니다" : "워크스페이스 보관"}</h2>
      {overwrite ? <p>'{overwrite.payload.name}' 보관본을 덮어쓰겠습니까?</p> : <>
        <label>이름<input className="settings-input" value={name} disabled={busy} autoFocus onChange={e => { setName(e.target.value); setRetryPayload(null); }} /></label>
        <label>프로젝트<select className="settings-input" value={projectId} disabled={busy || projectsLoading || projectsFailed} onChange={e => { setProjectId(e.target.value); setRetryPayload(null); }}>
          <option value="">프로젝트 없음</option>{availableProjects.filter(p => !p.archived).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select></label>
      </>}
      {(projectsFailed || error) && <p className="login-error" role="alert">{projectsFailed ? "프로젝트 목록을 불러오지 못했습니다." : error}</p>}
      <div className="admin-confirm-actions">
        <button className="admin-confirm-yes" disabled={busy || projectsLoading || projectsFailed} onClick={() => void save()}>{overwrite ? "덮어쓰기" : "보관"}</button>
        <button className="admin-confirm-no" disabled={busy} onClick={() => overwrite ? setOverwrite(null) : onClose()}>취소</button>
      </div>
    </div>
  </div>;
}
