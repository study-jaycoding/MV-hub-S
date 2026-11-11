import { useEffect, useMemo, useState } from "react";
import type { WorkspaceContext } from "../../types";
import { LoginScreen } from "../LoginScreen";
import { MediaThumbnail } from "../MediaThumbnail";
import { useEditGenerations, useEditProjects } from "../../lib/useEditSequence";
import type { FolderCountTreeNode } from "../../lib/folderTreeModel";
import { useT } from "../../lib/i18n";
import { BRIDGE_MISSING, bridgeCompatible, hasResolveBridge, PROTOCOL_MISMATCH } from "../../lib/resolvePanelApi";
import { useResolvePanel } from "../../lib/useResolvePanel";
import "../../styles/resolve-panel.css";

const ALL_WORKSPACES: WorkspaceContext = { scope: "unknown", id: null, name: null };
const selectionKey = "mvhub.resolvePanel.selection";
function savedSelection(): { project: string; sequence: string; cut: string } {
  try { return JSON.parse(sessionStorage.getItem(selectionKey) || "null") || { project: "", sequence: "", cut: "" }; }
  catch { return { project: "", sequence: "", cut: "" }; }
}
function folders(roots: FolderCountTreeNode[]): FolderCountTreeNode[] {
  return roots.flatMap(node => [node, ...folders(node.children || [])]);
}

function PanelContent({ panel }: { panel: ReturnType<typeof useResolvePanel> }) {
  const t = useT();
  const [selection, setSelection] = useState(savedSelection);
  // team+id일 때만 프로젝트가 제한된다 — 'unknown'은 workspace_id 없는 전체 목록이다.
  const projects = useEditProjects({ authKey: panel.authKey, workspace: ALL_WORKSPACES, projectId: selection.project || null });
  const sequences = useMemo(() => folders(projects.tree.roots).filter(node => node.children?.length), [projects.tree.roots]);
  const sequence = sequences.find(node => node.path === selection.sequence) || sequences[0];
  const cuts = useMemo(() => [...(sequence?.children || [])].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })), [sequence]);
  const cut = cuts.find(node => node.path === selection.cut) || cuts[0];
  const list = useEditGenerations({ authKey: panel.authKey, workspace: ALL_WORKSPACES, projectId: selection.project || null,
    seq: sequence?.path || null, allWorkspaces: true });
  const gens = list.gens.filter(gen => gen.folder_path === cut?.path);
  const ids = gens.map(gen => gen.id).join("\0");
  useEffect(() => {
    if (projects.projectsState === "ok" && !projects.projects.some(project => project.id === selection.project)) {
      setSelection({ project: projects.projects[0]?.id || "", sequence: "", cut: "" });
    }
  }, [projects.projects, projects.projectsState, selection.project]);
  useEffect(() => {
    try { sessionStorage.setItem(selectionKey, JSON.stringify({ project: selection.project, sequence: sequence?.path || "", cut: cut?.path || "" })); } catch { /* 저장소가 막혀도 조회는 유지한다. */ }
  }, [selection.project, sequence?.path, cut?.path]);
  useEffect(() => {
    if (list.state === "ok" || list.state === "capped") panel.selectCut(selection.project, cut?.path || "", gens);
    else panel.selectCut("", "", []);
    // 카드 목록 자체의 재생성으로 같은 컷을 다시 선택하지 않는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection.project, cut?.path, ids, list.state, panel.selectCut]);
  const choose = (next: typeof selection) => { panel.selectCut("", "", []); setSelection(next); };
  const bridgePresent = hasResolveBridge(window.mvhubResolve);
  const different = bridgePresent && panel.current?.state === "ok" && panel.target?.state === "ok"
    && (panel.current.resolve_project_id !== panel.target.resolve_project_id || panel.current.bin_id !== panel.target.bin_id);
  const checking = panel.current && panel.current.state !== "ok";

  return <div className="resolve-panel">
    <header className="resolve-panel-head">
      <strong>MV Hub <span>{t("리졸브")}</span></strong>
      <div className="resolve-panel-pickers">
        <select aria-label={t("프로젝트")} value={selection.project} onChange={event => choose({ project: event.target.value, sequence: "", cut: "" })}>
          <option value="">{t("프로젝트 고르기")}</option>
          {projects.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select><span aria-hidden="true">›</span>
        <select aria-label={t("시퀀스")} value={sequence?.path || ""} onChange={event => choose({ ...selection, sequence: event.target.value, cut: "" })}>
          {!sequences.length && <option value="">{t("시퀀스 고르기")}</option>}
          {sequences.map(node => <option key={node.path} value={node.path}>{node.path}</option>)}
        </select>
      </div>
      <div className="resolve-panel-status" role="status">{!bridgePresent ? t(BRIDGE_MISSING) : <>{panel.notice || `${t("리졸브 빈")}: ${t("확인 중")}`}{checking && <span> · {t("확인 중")}</span>}</>}</div>
      {bridgePresent && <p>{t("이 창이 리졸브 미디어 풀의 지금 빈을 고른 컷으로 바꿉니다")}</p>}
      {different && <div className="resolve-panel-warning">{t("리졸브 지금 빈이 선택한 컷과 다릅니다")}: {cut?.name} <button onClick={panel.align}>{t("맞추기")}</button></div>}
      {bridgePresent && !bridgeCompatible(window.mvhubResolve, panel.identity) && <div className="resolve-panel-warning">{t(PROTOCOL_MISMATCH)}</div>}
    </header>
    <div className="resolve-panel-body">
      <nav aria-label={t("컷 목록")}>
        {cuts.map(node => <button className={node.path === cut?.path ? "selected" : ""} key={node.path}
          onClick={() => choose({ ...selection, cut: node.path })}>
          <strong>{node.name}</strong><span>{t("공유")} {node.count ?? "—"}</span>
          <small>★ {node.reviewCounts?.final ?? "—"} · {t("보류")} {node.reviewCounts?.held ?? "—"}</small>
        </button>)}
      </nav>
      <main aria-label={t("공유물 목록")}>
        {(projects.tree.note || list.error) && <p role="alert">{projects.tree.note || list.error}</p>}
        {list.state === "loading" && <p>{t("받는 중")}</p>}
        {list.state === "capped" && <p>{t("최대 2,000건 표시")}</p>}
        {!gens.length && list.state === "ok" && <p>{t("이 컷에 공유물이 없습니다")}</p>}
        {gens.map(gen => {
          const asset = gen.assets[0];
          const state = panel.cards[gen.id];
          return <article key={gen.id} className="resolve-panel-card" draggable
            onPointerDown={() => void panel.prepareCard(gen.id)} onDragStart={event => panel.drag(gen.id, event)}>
            <MediaThumbnail className="resolve-panel-thumb" thumb={asset?.thumbnail_path || (asset?.type === "image" ? asset.file_path : null)}
              src={asset?.file_path} isVideo={asset?.type === "video"} alt={gen.model || t("공유물")} fallback={<span>◇</span>} />
            <div className="resolve-panel-card-info">
              <strong>{gen.creator_name || gen.worker_name || t("작성자 미상")}</strong>
              <div>{gen.model || "—"} · {gen.params?.duration ? `${String(gen.params.duration)}s` : "—"}</div>
              <small>{new Date(gen.created_at).toLocaleDateString()} {gen.is_final && <b className="resolve-panel-final">★ {t("최종")}</b>} {gen.is_held && <b>{t("보류")}</b>}</small>
              {bridgePresent && <div className="resolve-panel-card-state" role="status">{state?.message || t("카드를 누르면 준비합니다")}
                {state?.retry && <button onPointerDown={event => event.stopPropagation()} onClick={() => void panel.adopt(gen.id)}>{t("다시 확인")}</button>}
              </div>}
            </div>
          </article>;
        })}
      </main>
    </div>
  </div>;
}

export function ResolvePanelApp() {
  const panel = useResolvePanel();
  const t = useT();
  useEffect(() => { document.title = "MV Hub — Resolve"; }, []);
  if (panel.needsLogin && panel.config) return <LoginScreen config={panel.config} onAuthed={panel.onAuthed} />;
  if (!panel.identity || !panel.authReady) return <div className="resolve-panel resolve-panel-loading" role="status">{panel.notice || t("계정 문맥을 확인 중입니다")}</div>;
  return <PanelContent key={panel.authKey} panel={panel} />;
}
