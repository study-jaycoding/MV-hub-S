import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import type { Generation, WorkspaceContext } from "../../types";
import { api } from "../../api";
import { LoginScreen } from "../LoginScreen";
import { useEditGenerations, useEditProjects } from "../../lib/useEditSequence";
import type { FolderCountTreeNode } from "../../lib/folderTreeModel";
import { useT } from "../../lib/i18n";
import { BRIDGE_MISSING, bridgeCompatible, hasResolveBridge, PROTOCOL_MISMATCH } from "../../lib/resolvePanelApi";
import { useResolvePanel } from "../../lib/useResolvePanel";
import { KEY_COLORS } from "../../lib/appConstants";
import { APP_EVENTS } from "../../lib/appEvents";
import { NO_POOL_FILTER, POOL_SIZE, type PoolFilter, type PoolSort, type PoolView } from "../../lib/editTimelineStore";
import { canFinalizeGeneration } from "../../lib/generationDisplay";
import { useGenerationCardActions } from "../../lib/useGenerationCardActions";
import { useGenerationTagActions } from "../../lib/useGenerationTagActions";
import { useOutsideMouseDown } from "../../lib/useOutsideMouseDown";
import { ColorFilterDots } from "../common/ColorFilterDots";
import type { PoolCardActions } from "../timeline/EditCard";
import { arrangePool, poolFacets, poolFilterPass } from "../timeline/EditPool";
import { ResolvePanelCard } from "./ResolvePanelCards";
import "../../styles/edit-tab.css";
import "../../styles/resolve-panel.css";

const ALL_WORKSPACES: WorkspaceContext = { scope: "unknown", id: null, name: null };
const selectionKey = "mvhub.resolvePanel.selection";
const uiKey = "mvhub.resolvePanel.ui";
const REFRESH_MS = 15_000; // 공유 & 리뷰 탭의 목록 확인 간격과 같다
const COLOR_DOTS = [{ k: "r", hex: KEY_COLORS.r }, { k: "g", hex: KEY_COLORS.g }, { k: "b", hex: KEY_COLORS.b }];
const VIEWS: { id: PoolView; label: string }[] = [{ id: "meta", label: "메타데이터 보기" }, { id: "thumb", label: "썸네일 보기" }, { id: "list", label: "목록 보기" }];
const NO_GRAY = new Set<string>();
const noop = () => {};
interface PanelUi { view: PoolView; size: number; sort: PoolSort; filterOpen: boolean; filter: PoolFilter }
const DEFAULT_UI: PanelUi = { view: "thumb", size: 120, sort: "new", filterOpen: false, filter: NO_POOL_FILTER };

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
  // 태그 저장의 낙관적 반영은 이 사본에 — 다시 받은 목록이 오면 그것으로 덮는다(앱의 태그 훅과 같은 약속).
  const [gens, setGens] = useState<Generation[]>(list.gens);
  useEffect(() => setGens(list.gens), [list.gens]);
  const gensRef = useRef(gens); gensRef.current = gens;
  const cutGens = useMemo(() => gens.filter(gen => gen.folder_path === cut), [gens, cut]);
  const ids = cutGens.map(gen => gen.id).join("\0");
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
      chosen.current = key; panel.selectCut(selection.project, cut, cutGens);
    } else if (ready) panel.addCards(cutGens);
    // 카드 목록 자체의 재생성으로 같은 컷을 다시 선택하지 않는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection.project, cut, ids, ready, panel.selectCut, panel.addCards]);
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

  // 카드의 S·T — 앱의 저장 훅을 그대로(권한·느린 요청·부분 실패 규칙). 최종 권한은 앱과 같은 조회로 받고, 403 이면 다시 읽는다.
  const [flash, setFlash] = useState("");
  const [finalizeProjects, setFinalizeProjects] = useState(new Set<string>());
  useEffect(() => {
    let alive = true;
    const read = () => { api.myFinalizeRoles().then(r => { if (alive) setFinalizeProjects(new Set(r.project_ids)); }, () => {}); };
    read(); window.addEventListener(APP_EVENTS.finalizeRolesStale, read);
    return () => { alive = false; window.removeEventListener(APP_EVENTS.finalizeRolesStale, read); };
  }, []);
  const canFinalize = useCallback((gen: Generation) => canFinalizeGeneration(gen, finalizeProjects), [finalizeProjects]);
  const selectedRef = useRef(new Set<string>());
  const tagActions = useGenerationTagActions({ flash: setFlash, gensRef, onTagNamesAdded: noop, reload: () => reloadList(), selectedRef, setGens });
  const cardActions = useGenerationCardActions({ armedAutoTags: NO_GRAY, bumpBoard: noop, canFinalize, flash: setFlash, navTab: noop,
    reload: async () => reloadList(), workspace: ALL_WORKSPACES });
  const facets = useMemo(() => poolFacets(cutGens), [cutGens]);
  // 공유물만 보이는 창이라 S 는 공유 탭 갈래(onReview)만 쓴다 — 워크스페이스 갈래(공유 올리기·내리기)는 오지 않는다.
  const actions: PoolCardActions = { canFinalize, onReview: cardActions.onReview, onPublish: noop, onUnpublish: noop,
    onFinalize: cardActions.onFinalize, onUnfinalize: cardActions.onUnfinalize, onSetTags: tagActions.onSetTags,
    onSetAutoTags: tagActions.onSetAutoTags, autoTagOptions: facets.autoTags, onOpenComments: noop, onInfo: noop };
  const [tagging, setTagging] = useState<string | null>(null);

  const [menu, setMenu] = useState(false);
  const toolsRef = useRef<HTMLDivElement>(null);
  useOutsideMouseDown(toolsRef, () => setMenu(false), menu);
  const [query, setQuery] = useState<string | null>(null);
  const pass = poolFilterPass(ui.filter, NO_GRAY);
  const shown = arrangePool(cutGens.filter(gen => !pass || pass(gen)).map(gen => ({ gen, track: null, showing: false })), query ?? "", ui.sort);
  const filterCount = ui.filter.colors.length + ui.filter.autoTags.length + (ui.filter.final ? 1 : 0) + (ui.filter.creator ? 1 : 0);
  const changeFilter = (patch: Partial<PoolFilter>) => patchUi({ filter: { ...ui.filter, ...patch } });

  const choose = (next: typeof selection) => setSelection(next);
  const bridgePresent = hasResolveBridge(window.mvhubResolve);
  const different = bridgePresent && panel.current?.state === "ok" && panel.target?.state === "ok"
    && (panel.current.resolve_project_id !== panel.target.resolve_project_id || panel.current.bin_id !== panel.target.bin_id);
  const checking = panel.current && panel.current.state !== "ok";
  const projectName = projects.projects.find(project => project.id === selection.project)?.name || "";

  return <div className="resolve-panel">
    <header className="resolve-panel-head">
      <strong>MV Hub <span>{t("리졸브")}</span></strong>
      <div className="resolve-panel-status" role="status">{!bridgePresent ? t(BRIDGE_MISSING) : <>{panel.notice || `${t("리졸브 빈")}: ${t("확인 중")}`}{checking && <span> · {t("확인 중")}</span>}</>}</div>
      {bridgePresent && <p>{t("이 창이 리졸브 미디어 풀의 지금 빈을 고른 컷으로 바꿉니다")}</p>}
      {different && <div className="resolve-panel-warning">{t("리졸브 지금 빈이 선택한 컷과 다릅니다")}: {cut.split("/").pop()} <button onClick={panel.align}>{t("맞추기")}</button></div>}
      {bridgePresent && !bridgeCompatible(window.mvhubResolve, panel.identity) && <div className="resolve-panel-warning">{t(PROTOCOL_MISMATCH)}</div>}
      {flash && <div className="rp-flash" role="alert">{flash} <button onClick={() => setFlash("")} aria-label={t("닫기")}>×</button></div>}
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
      <main aria-label={t("공유물 목록")}>
        <div className="rp-tools" ref={toolsRef}>
          <span className="rp-path">{[projectName, ...cut.split("/").filter(Boolean)].join(" / ")}</span>
          <button type="button" className={"rp-tool" + (menu ? " on" : "")} aria-haspopup="menu" aria-expanded={menu} aria-label={t("보기 방식")}
            title={t("보기 방식")} onClick={() => setMenu(!menu)}>{t(VIEWS.find(view => view.id === ui.view)!.label)} ▾</button>
          <button type="button" className={"rp-tool" + (query !== null ? " on" : "")} aria-label={t("검색")} title={t("검색")}
            onClick={() => setQuery(query === null ? "" : null)}>⌕</button>
          <select className="rp-tool" aria-label={t("정렬")} value={ui.sort} onChange={event => patchUi({ sort: event.target.value as PoolSort })}>
            <option value="new">{t("최신순")}</option><option value="old">{t("오래된순")}</option>
          </select>
          {menu && <div className="rp-menu" role="menu">
            {VIEWS.map(view => <button key={view.id} type="button" role="menuitemradio" aria-checked={ui.view === view.id}
              onClick={() => { patchUi({ view: view.id }); setMenu(false); }}><b>{ui.view === view.id ? "✓" : ""}</b>{t(view.label)}</button>)}
            <input type="range" min={POOL_SIZE.min} max={POOL_SIZE.max} step={10} value={ui.size} disabled={ui.view === "list"}
              aria-label={t("썸네일 크기")} title={t("썸네일 크기")} onChange={event => patchUi({ size: Number(event.target.value) })} />
          </div>}
        </div>
        {query !== null && <input className="rp-search" autoFocus placeholder={t("프롬프트·모델·작성자")} value={query} onChange={event => setQuery(event.target.value)} />}
        {(projects.tree.note || list.error) && <p role="alert">{projects.tree.note || list.error}</p>}
        {!cut && <p className="rp-empty-note">{t("왼쪽에서 컷을 고르세요")}</p>}
        {cut && list.state === "loading" && !cutGens.length && <p>{t("받는 중")}</p>}
        {list.state === "capped" && <p>{t("최대 2,000건 표시")}</p>}
        {cut && !cutGens.length && list.state === "ok" && <p>{t("이 컷에 공유물이 없습니다")}</p>}
        <div className={"rp-cards rp-" + ui.view}>
          {shown.map(({ gen }) => <ResolvePanelCard key={gen.id} gen={gen} view={ui.view} size={ui.size} state={panel.cards[gen.id]}
            bridge={bridgePresent} actions={actions} tagging={tagging === gen.id} onTagging={on => setTagging(on ? gen.id : null)}
            onPrepare={() => void panel.prepareCard(gen.id)} onDrag={event => panel.drag(gen.id, event)} onRetry={() => void panel.adopt(gen.id)} />)}
        </div>
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
