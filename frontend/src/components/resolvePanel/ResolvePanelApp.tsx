import { Fragment, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import type { WorkspaceContext } from "../../types";
import { LoginScreen } from "../LoginScreen";
import { useEditGenerations, useEditProjects } from "../../lib/useEditSequence";
import type { FolderCountTreeNode } from "../../lib/folderTreeModel";
import { useT } from "../../lib/i18n";
import { BRIDGE_MISSING, bridgeCompatible, hasResolveBridge, PROTOCOL_MISMATCH } from "../../lib/resolvePanelApi";
import { useResolvePanel } from "../../lib/useResolvePanel";
import { KEY_COLORS } from "../../lib/appConstants";
import { NO_POOL_FILTER, type PoolFilter } from "../../lib/editTimelineStore";
import { ColorFilterDots } from "../common/ColorFilterDots";
import { poolFacets, poolFilterPass } from "../timeline/EditPool";
import "../../styles/edit-tab.css";
import "../../styles/resolve-panel.css";

const ALL_WORKSPACES: WorkspaceContext = { scope: "unknown", id: null, name: null };
const selectionKey = "mvhub.resolvePanel.selection";
const uiKey = "mvhub.resolvePanel.ui";
const REFRESH_MS = 15_000; // 공유 & 리뷰 탭의 목록 확인 간격과 같다
const COLOR_DOTS = [{ k: "r", hex: KEY_COLORS.r }, { k: "g", hex: KEY_COLORS.g }, { k: "b", hex: KEY_COLORS.b }];
const NO_GRAY = new Set<string>();
interface PanelUi { filterOpen: boolean; filter: PoolFilter }
const DEFAULT_UI: PanelUi = { filterOpen: false, filter: NO_POOL_FILTER };

function load<T>(storage: Storage, key: string, fallback: T): T {
  try { return { ...fallback, ...JSON.parse(storage.getItem(key) || "null") }; } catch { return fallback; }
}
const byName = (nodes: FolderCountTreeNode[] = []) => [...nodes].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
const ancestors = (path: string) => path.split("/").map((_, i, parts) => parts.slice(0, i + 1).join("/"));
const parentOf = (path: string) => path.split("/").slice(0, -1).join("/");

// 왼쪽 빈 트리 — 다빈치 미디어 풀처럼 프로젝트 › 폴더 › 컷. 하위가 있는 폴더는 펼치고, 끝 폴더(컷)를 누르면 그 컷을 고른다.
function Bins({ projects, openProject, roots, cut, onProject, onCut }: {
  projects: { id: string; name: string }[]; openProject: string; roots: FolderCountTreeNode[]; cut: string;
  onProject: (id: string) => void; onCut: (path: string) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(() => new Set(cut ? ancestors(cut) : []));
  useEffect(() => { if (cut) setOpen(prev => new Set([...prev, ...ancestors(cut)])); }, [cut]);
  const toggle = (path: string) => setOpen(prev => { const next = new Set(prev); if (!next.delete(path)) next.add(path); return next; });
  const row = (node: FolderCountTreeNode, depth: number): ReactElement => {
    const kids = byName(node.children);
    const pad = { paddingLeft: 8 + depth * 14 };
    if (kids.length) return <Fragment key={node.path}>
      <button className="rp-bin" style={pad} aria-expanded={open.has(node.path)} onClick={() => toggle(node.path)}>
        <span className="rp-chev" aria-hidden="true">{open.has(node.path) ? "▾" : "▸"}</span>{node.name}<span className="rp-count">{node.count || ""}</span>
      </button>
      {open.has(node.path) && kids.map(kid => row(kid, depth + 1))}
    </Fragment>;
    return <button key={node.path} style={pad} onClick={() => onCut(node.path)}
      className={"rp-bin rp-cut" + (node.path === cut ? " selected" : "") + (node.count ? "" : " rp-empty")}>
      {node.name}<span className="rp-count">{node.reviewCounts?.final ? <b>★{node.reviewCounts.final} · </b> : null}{node.count ?? ""}</span>
    </button>;
  };
  return <nav className="rp-bins" aria-label={t("컷 목록")}>
    {projects.map(project => <Fragment key={project.id}>
      <button className="rp-bin rp-project" aria-expanded={project.id === openProject} onClick={() => onProject(project.id)}>
        <span className="rp-chev" aria-hidden="true">{project.id === openProject ? "▾" : "▸"}</span>{project.name}
      </button>
      {project.id === openProject && byName(roots).map(node => row(node, 1))}
    </Fragment>)}
  </nav>;
}

function PanelContent({ panel }: { panel: ReturnType<typeof useResolvePanel> }) {
  const t = useT();
  const [selection, setSelection] = useState(() => {
    const saved = load(sessionStorage, selectionKey, { project: "", sequence: "", cut: "" });
    return { project: saved.project, cut: saved.cut };
  });
  const [ui, setUi] = useState<PanelUi>(() => load(localStorage, uiKey, DEFAULT_UI));
  const patchUi = (patch: Partial<PanelUi>) => setUi(prev => ({ ...prev, ...patch }));
  useEffect(() => { try { localStorage.setItem(uiKey, JSON.stringify(ui)); } catch { /* 저장소가 막혀도 보기는 유지한다. */ } }, [ui]);
  const cut = selection.cut;
  const sequence = parentOf(cut) || cut;
  // team+id일 때만 프로젝트가 제한된다 — 'unknown'은 workspace_id 없는 전체 목록이다.
  const projects = useEditProjects({ authKey: panel.authKey, workspace: ALL_WORKSPACES, projectId: selection.project || null });
  const list = useEditGenerations({ authKey: panel.authKey, workspace: ALL_WORKSPACES, projectId: selection.project || null,
    seq: sequence || null, allWorkspaces: true });
  const cutGens = useMemo(() => list.gens.filter(gen => gen.folder_path === cut), [list.gens, cut]);
  const pass = poolFilterPass(ui.filter, NO_GRAY);
  const filtered = cutGens.filter(gen => !pass || pass(gen));
  const ids = filtered.map(gen => gen.id).sort().join("\0");
  const ready = list.state === "ok" || list.state === "capped";

  useEffect(() => {
    if (projects.projectsState === "ok" && !projects.projects.some(project => project.id === selection.project)) {
      setSelection({ project: projects.projects[0]?.id || "", cut: "" });
    }
  }, [projects.projects, projects.projectsState, selection.project]);
  useEffect(() => {
    try { sessionStorage.setItem(selectionKey, JSON.stringify({ project: selection.project, sequence, cut })); } catch { /* 저장소가 막혀도 조회는 유지한다. */ }
  }, [selection.project, sequence, cut]);
  // 컷이 바뀔 때만 컷 선택(리졸브 지금 빈 맞추기). 같은 컷을 다시 읽어 생긴 카드는 캐시만 받는다 — 다시 읽는 중(loading)에 선택을 풀지 않는다.
  const chosen = useRef("");
  useEffect(() => {
    const key = `${selection.project}\n${cut}`;
    if (key !== chosen.current) {
      if (!ready || !cut) { if (chosen.current) { chosen.current = ""; panel.selectCut("", "", []); } return; }
      chosen.current = key; panel.selectCut(selection.project, cut, filtered, list.state === "capped");
    } else if (ready) panel.updateSet(filtered, list.state === "capped");
    // 카드 목록 자체의 재생성으로 같은 컷을 다시 선택하지 않는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection.project, cut, ids, ready, list.state, panel.selectCut, panel.updateSet]);
  // 공유가 늘면 저절로 — 보이는 동안 15초마다·창으로 돌아올 때(3초 안 중복은 건너뜀). 리졸브 안 창은 앱의 '생성물 바뀜' 알림을 못 받는다.
  const lastRefresh = useRef(0);
  const { reload: reloadList } = list;
  const { reloadCounts } = projects;
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "hidden" || Date.now() - lastRefresh.current < 3000) return;
      lastRefresh.current = Date.now(); reloadList(); reloadCounts();
    };
    const timer = window.setInterval(refresh, REFRESH_MS);
    window.addEventListener("focus", refresh);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [reloadList, reloadCounts]);

  const facets = useMemo(() => poolFacets(cutGens), [cutGens]);
  const filterCount = ui.filter.colors.length + ui.filter.autoTags.length + (ui.filter.final ? 1 : 0) + (ui.filter.creator ? 1 : 0);
  const changeFilter = (patch: Partial<PoolFilter>) => patchUi({ filter: { ...ui.filter, ...patch } });

  const choose = (next: typeof selection) => setSelection(next);
  const bridgePresent = hasResolveBridge(window.mvhubResolve);
  const different = bridgePresent && panel.current?.state === "ok" && panel.target?.state === "ok"
    && (panel.current.resolve_project_id !== panel.target.resolve_project_id || panel.current.bin_id !== panel.target.bin_id);
  const checking = panel.current && panel.current.state !== "ok";

  return <div className="resolve-panel">
    <header className="resolve-panel-head">
      <strong>MV Hub <span>{t("리졸브")}</span></strong>
      <div className="resolve-panel-status" role="status">{!bridgePresent ? t(BRIDGE_MISSING) : <>{panel.notice || `${t("리졸브 빈")}: ${t("확인 중")}`}{checking && <span> · {t("확인 중")}</span>}</>}</div>
      {bridgePresent && <p>{t("이 창이 리졸브 미디어 풀의 지금 빈을 고른 컷으로 바꿉니다")}</p>}
      {different && <div className="resolve-panel-warning">{t("리졸브 지금 빈이 선택한 컷과 다릅니다")}: {cut.split("/").pop()} <button onClick={panel.align}>{t("맞추기")}</button></div>}
      {bridgePresent && !bridgeCompatible(window.mvhubResolve, panel.identity) && <div className="resolve-panel-warning">{t(PROTOCOL_MISMATCH)}</div>}
    </header>
    <div className="resolve-panel-body">
      <aside className="rp-side">
        <Bins projects={projects.projects} openProject={selection.project} roots={projects.tree.roots} cut={cut}
          onProject={id => { if (id !== selection.project) choose({ project: id, cut: "" }); }}
          onCut={path => choose({ ...selection, cut: path })} />
        <button type="button" className={"sidebar-foot-toggle" + (ui.filterOpen ? " on" : "")} aria-expanded={ui.filterOpen}
          onClick={() => patchUi({ filterOpen: !ui.filterOpen })}>
          <span className="sidebar-foot-pin">📌</span>{t("컬러")} · {t("전역 태그")} · {t("생성자")}
          {!ui.filterOpen && filterCount > 0 && <span className="ed-foot-count">{filterCount}</span>}
        </button>
        {ui.filterOpen && <div className="sidebar-foot rp-filter">
          <section><h4>{t("컬러")}</h4><div className="color-dots">
            <ColorFilterDots colorDots={COLOR_DOTS} activeColors={new Set(ui.filter.colors)} finalOnly={ui.filter.final}
              onToggleFinal={() => changeFilter({ final: !ui.filter.final })}
              onToggleColor={hex => changeFilter({ colors: ui.filter.colors.includes(hex) ? ui.filter.colors.filter(item => item !== hex) : [...ui.filter.colors, hex] })} />
          </div></section>
          <section><h4>{t("전역 태그")}</h4><div className="chips">
            {!facets.autoTags.length && <span className="muted">{t("없음")}</span>}
            {facets.autoTags.map(tag => { const on = ui.filter.autoTags.includes(tag); return <span key={tag} className={"auto-tag-chip" + (on ? " on" : "")}>
              <button type="button" className="auto-tag-name" onClick={() => changeFilter({ autoTags: on ? ui.filter.autoTags.filter(item => item !== tag) : [...ui.filter.autoTags, tag] })}>{tag}</button>
            </span>; })}
          </div></section>
          {facets.creators.length > 0 && <section><h4>{t("생성자")}</h4>
            {facets.creators.map(creator => <div key={creator.key} className={"creator-row" + (ui.filter.creator === creator.key ? " on" : "")}>
              <button type="button" className="creator-pick" onClick={() => changeFilter({ creator: ui.filter.creator === creator.key ? null : creator.key })}>
                <span className="creator-dot" style={{ background: creator.mine ? "var(--accent)" : "#4ade80" }} />
                <span className="creator-name">{creator.name || (creator.mine ? t("나") : t("팀원"))}</span><span className="creator-count">{creator.count}</span>
              </button>
            </div>)}
          </section>}
        </div>}
      </aside>
      <main aria-label={t("리졸브 상태")}>
        {(projects.tree.note || list.error) && <p role="alert">{projects.tree.note || list.error}</p>}
        {!cut && <p className="rp-empty-note">{t("왼쪽에서 컷을 고르세요")}</p>}
        {bridgePresent && <>
          {!panel.identity?.writer && <p>{t("다른 MV 창이 리졸브를 맡고 있습니다")} <button onClick={() => void panel.takeover()}>{t("넘겨받기")}</button></p>}
          <p>{t("띄움")} {panel.stage?.items?.filter(item => ["staged", "present"].includes(item.state)).length || 0} · {t("쓰인 것")} {panel.current?.used ? panel.current.used.length : t("확인 중")} — {t("NAS로 옮김")} {panel.moved}</p>
          {!!panel.stage?.deferred && <p>{t("새 공유물")} {panel.stage.deferred} · {t("리졸브 지금 빈이 선택한 컷과 다릅니다")} <button onClick={panel.align}>{t("맞추기")}</button></p>}
          {!!panel.stage?.items?.filter(item => item.state === "same_file_exists").length && <p>{t("같은 파일 항목이 이미 있습니다")} {panel.stage.items.filter(item => item.state === "same_file_exists").length}</p>}
          {panel.stage?.capped && <p>{t("앞 200개만 띄웁니다 — 이 컷에서는 지우지 않습니다")}</p>}
          {!!panel.stage?.unexpected_imports && <p>{t("가져오기가 어긋난 항목")} {panel.stage.unexpected_imports}{t("개 — 손대지 않았습니다")}</p>}
          <p>{t("다른 허브")} {panel.counts.other_owner} · {t("확인 필요")} {panel.counts.needs_attention}</p>
          {panel.failures.map((failure, index) => <p role="alert" key={index}>{failure}</p>)}
          {panel.canRetry && <button onClick={panel.retry}>{t("다시")}</button>}
        </>}
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
