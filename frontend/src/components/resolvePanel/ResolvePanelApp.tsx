import { Fragment, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import type { WorkspaceContext } from "../../types";
import { LoginScreen } from "../LoginScreen";
import { findFolder, useEditGenerations, useEditProjects } from "../../lib/useEditSequence";
import type { FolderCountTreeNode } from "../../lib/folderTreeModel";
import { useT } from "../../lib/i18n";
import { BRIDGE_MISSING, bridgeCompatible, hasResolveBridge, PROTOCOL_MISMATCH } from "../../lib/resolvePanelApi";
import { loadSavedSelection, PANEL_SELECTION_KEY, useResolvePanel } from "../../lib/useResolvePanel";
import { KEY_COLORS } from "../../lib/appConstants";
import { NO_POOL_FILTER, type EditUi, type PoolFilter } from "../../lib/editTimelineStore";
import { ColorFilterDots } from "../common/ColorFilterDots";
import { EditPool, poolFacets, poolFilterPass, type PoolItem } from "../timeline/EditPool";
import "../../styles/edit-tab.css";
import "../../styles/resolve-panel.css";

const ALL_WORKSPACES: WorkspaceContext = { scope: "unknown", id: null, name: null };
const uiKey = "mvhub.resolvePanel.ui";
const REFRESH_MS = 15_000; // 공유 & 리뷰 탭의 목록 확인 간격과 같다
const COLOR_DOTS = [{ k: "r", hex: KEY_COLORS.r }, { k: "g", hex: KEY_COLORS.g }, { k: "b", hex: KEY_COLORS.b }];
const NO_GRAY = new Set<string>();
const NO_PICK: string[] = [];
const noop = () => {};
const NO_SEND = { send: noop, busy: false, pendingCount: 0 };
// 오른쪽 칸 = 편집 탭 미디어 풀(보기 전용, Jay 2026-11-12) — 보기·크기·정렬·사이드바 닫힘만 기억한다. 나머지는 EditUi 형식을 채우는 값.
type PoolUi = Pick<EditUi, "view" | "size" | "sort" | "sideHidden">;
const POOL_UI: EditUi = { view: "meta", size: 130, sort: "new", dual: false, views: ["source", "timeline"], loop: false, loopSrc: false,
  speed: 1, markerColor: "#ff5722", sideHidden: false, volumes: [1, 1], filterOpen: false, poolFilter: NO_POOL_FILTER };
interface PanelUi { filterOpen: boolean; filter: PoolFilter; pool: PoolUi }
const DEFAULT_UI: PanelUi = { filterOpen: false, filter: NO_POOL_FILTER, pool: { view: "meta", size: 130, sort: "new", sideHidden: false } };

function loadUi(): PanelUi {
  try {
    const saved = { ...DEFAULT_UI, ...JSON.parse(localStorage.getItem(uiKey) || "null") } as PanelUi;
    const pool = { ...DEFAULT_UI.pool, ...saved.pool };
    return { ...saved, pool: { ...pool, view: ["thumb", "meta", "list"].includes(pool.view) ? pool.view : "meta" } };
  } catch { return DEFAULT_UI; }
}
const byName = (nodes: FolderCountTreeNode[] = []) => [...nodes].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
const ancestors = (path: string) => path ? path.split("/").map((_, i, parts) => parts.slice(0, i + 1).join("/")) : [];
const parentOf = (path: string) => path.split("/").slice(0, -1).join("/");
const lastName = (path: string) => path.split("/").pop() || "";
// 에피소드 = 생성물 있는 컷(하위가 없는 폴더)을 가진 폴더 — 이름을 누르면 그 컷 빈만 다빈치에 만든다(트리 개수라 목록 상한과 무관)
const episodeCuts = (node: FolderCountTreeNode | null) => byName(node?.children).filter(kid => !kid.children?.length && !!kid.count);

// 왼쪽 빈 트리 — 다빈치 미디어 풀처럼 프로젝트 › 에피소드 › 컷. 화살표 = 펼치기만, 에피소드 이름 = 컷 빈 만들기, 컷 = 그 컷 고르기.
function Bins({ projects, openProject, roots, episode, cut, onProject, onEpisode, onCut }: {
  projects: { id: string; name: string }[]; openProject: string; roots: FolderCountTreeNode[]; episode: string; cut: string;
  onProject: (id: string) => void; onEpisode: (path: string) => void; onCut: (path: string) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(() => new Set(ancestors(cut || episode)));
  useEffect(() => { setOpen(prev => new Set([...prev, ...ancestors(cut || episode)])); }, [cut, episode]);
  const toggle = (path: string) => setOpen(prev => { const next = new Set(prev); if (!next.delete(path)) next.add(path); return next; });
  const row = (node: FolderCountTreeNode, depth: number): ReactElement => {
    const kids = byName(node.children);
    const pad = { paddingLeft: 8 + depth * 14 };
    if (kids.length) {
      const expanded = open.has(node.path);
      const cuts = episodeCuts(node);
      return <Fragment key={node.path}>
        <div className={"rp-bin rp-folder" + (node.path === episode && !cut ? " selected" : "")} style={pad}>
          <button type="button" className="rp-chev" aria-expanded={expanded} onClick={() => toggle(node.path)}
            aria-label={`${node.name} ${t(expanded ? "폴더 접기" : "폴더 펼치기")}`}>{expanded ? "▾" : "▸"}</button>
          <button type="button" className="rp-name" onClick={() => (cuts.length ? onEpisode(node.path) : toggle(node.path))}
            title={cuts.length ? t("생성물 있는 컷 빈을 다빈치에 만듭니다") : undefined}>{node.name}</button>
          <span className="rp-count">{node.count || ""}</span>
        </div>
        {expanded && kids.map(kid => row(kid, depth + 1))}
      </Fragment>;
    }
    return <button key={node.path} type="button" style={pad} onClick={() => onCut(node.path)}
      className={"rp-bin rp-cut" + (node.path === cut ? " selected" : "") + (node.count ? "" : " rp-empty")}>
      {node.name}<span className="rp-count">{node.reviewCounts?.final ? <b>★{node.reviewCounts.final} · </b> : null}{node.count ?? ""}</span>
    </button>;
  };
  return <nav className="rp-bins" aria-label={t("컷 목록")}>
    {projects.map(project => <Fragment key={project.id}>
      <button type="button" className="rp-bin rp-project" aria-expanded={project.id === openProject} onClick={() => onProject(project.id)}>
        <span className="rp-chev" aria-hidden="true">{project.id === openProject ? "▾" : "▸"}</span>{project.name}
      </button>
      {project.id === openProject && byName(roots).map(node => row(node, 1))}
    </Fragment>)}
  </nav>;
}

// 에피소드만 고른 때의 오른쪽 — 생성물 있는 컷 폴더 타일(누르면 그 컷을 고른다 = 다빈치도 그 빈으로)
function EpisodeTiles({ title, cuts, onCut }: { title: string; cuts: FolderCountTreeNode[]; onCut: (path: string) => void }) {
  const t = useT();
  return <section className="ed-pool rp-tiles-wrap">
    <div className="ed-pool-head"><h3 title={title}>{title}</h3></div>
    <div className="ed-pool-sub">{t("생성물 있는 컷 {count}개").replace("{count}", String(cuts.length))}</div>
    {!cuts.length && <div className="ed-pool-note">{t("이 폴더에는 생성물 있는 컷이 없습니다")}</div>}
    <div className="rp-tiles">{cuts.map(node => <button key={node.path} type="button" className="rp-tile" onClick={() => onCut(node.path)}>
      <span className="rp-ficon" aria-hidden="true" /><b>{node.name}</b><i>{node.count}</i>
    </button>)}</div>
  </section>;
}

function PanelContent({ panel }: { panel: ReturnType<typeof useResolvePanel> }) {
  const t = useT();
  const [selection, setSelection] = useState(loadSavedSelection);
  const [ui, setUi] = useState<PanelUi>(loadUi);
  const patchUi = (patch: Partial<PanelUi>) => setUi(prev => ({ ...prev, ...patch }));
  useEffect(() => { try { localStorage.setItem(uiKey, JSON.stringify(ui)); } catch { /* 저장소가 막혀도 보기는 유지한다. */ } }, [ui]);
  const { cut, episode } = selection;
  // team+id일 때만 프로젝트가 제한된다 — 'unknown'은 workspace_id 없는 전체 목록이다.
  const projects = useEditProjects({ authKey: panel.authKey, workspace: ALL_WORKSPACES, projectId: selection.project || null });
  const list = useEditGenerations({ authKey: panel.authKey, workspace: ALL_WORKSPACES, projectId: selection.project || null,
    seq: episode || cut || null, allWorkspaces: true });
  const episodeNode = useMemo(() => (episode ? findFolder(projects.tree.roots, episode) : null), [projects.tree.roots, episode]);
  const cutNodes = useMemo(() => episodeCuts(episodeNode), [episodeNode]);
  const cutGens = useMemo(() => (cut ? list.gens.filter(gen => gen.folder_path === cut) : []), [list.gens, cut]);
  const pass = poolFilterPass(ui.filter, NO_GRAY);
  const filtered = cutGens.filter(gen => !pass || pass(gen));
  const ids = filtered.map(gen => gen.id).sort().join("\0");
  // 트리를 받은 뒤에 고른다 — 컷 목록(빈을 만들 것)이 빈 채로 target 이 나가지 않게
  const treeSettled = projects.tree.state === "ready" || projects.tree.state === "error";
  const ready = treeSettled && (!cut || list.state === "ok" || list.state === "capped");

  useEffect(() => {
    if (projects.projectsState === "ok" && !projects.projects.some(project => project.id === selection.project)) {
      setSelection({ project: projects.projects[0]?.id || "", episode: "", cut: "" });
    }
  }, [projects.projects, projects.projectsState, selection.project]);
  useEffect(() => {
    try { localStorage.setItem(PANEL_SELECTION_KEY, JSON.stringify(selection)); } catch { /* 저장소가 막혀도 조회는 유지한다. */ }
  }, [selection]);
  // 고른 곳이 바뀔 때만 리졸브에 알린다. 같은 컷을 다시 읽어 생긴 카드는 다시 띄우기만 — 읽는 중(loading)에 선택을 풀지 않는다
  //  (풀면 앞 에피소드 정리가 새 target 보다 먼저 돈다).
  const folderKey = `${selection.project}\n${episode}\n${cut}`;
  const chosen = useRef("");
  useEffect(() => {
    if (folderKey !== chosen.current) {
      if (!cut && !episode) { if (chosen.current) { chosen.current = ""; panel.selectFolder("", "", "", []); } return; }
      if (!ready) return;
      chosen.current = folderKey;
      panel.selectFolder(selection.project, episode, cut, filtered, list.state === "capped", cutNodes.map(node => node.path));
    } else if (ready && cut) panel.updateSet(filtered, list.state === "capped");
    // 카드 목록 자체의 재생성으로 같은 곳을 다시 고르지 않는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderKey, ids, ready, list.state, panel.selectFolder, panel.updateSet]);
  // 다빈치에서 컷 빈에 들어가면 그 컷으로, 에피소드 빈으로 돌아오면 컷 선택을 풀고 따라간다
  useEffect(() => {
    const follow = panel.follow;
    if (follow && follow.project === selection.project && follow.episode === episode && follow.cut !== cut) {
      setSelection({ project: follow.project, episode: follow.episode, cut: follow.cut });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel.follow]);
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

  const facets = useMemo(() => poolFacets(cut ? cutGens : list.gens), [cut, cutGens, list.gens]);
  const filterCount = ui.filter.colors.length + ui.filter.autoTags.length + (ui.filter.final ? 1 : 0) + (ui.filter.creator ? 1 : 0);
  const changeFilter = (patch: Partial<PoolFilter>) => patchUi({ filter: { ...ui.filter, ...patch } });
  // 카드 표 — 편집 탭의 'V1 - 선택 카드' 자리: 이번 창에서 NAS 로 바꿔 끼운 것(라임) · 타임라인에 쓴 것 · 빈에 띄운 것
  const poolItems = useMemo<PoolItem[]>(() => {
    const staged = new Set((panel.stage?.items || []).filter(item => ["staged", "present"].includes(item.state)).map(item => item.gen_id));
    const used = new Set(panel.current?.used || []);
    return cutGens.map(gen => ({ gen, track: null, showing: false,
      note: panel.nas.has(gen.id) ? { label: t("쓰임 · NAS"), lead: true } : used.has(gen.id) ? { label: t("쓰임") }
        : staged.has(gen.id) ? { label: t("띄움") } : undefined }));
  }, [cutGens, panel.stage, panel.current, panel.nas, t]);
  const poolUi = useMemo(() => ({ ...POOL_UI, ...ui.pool }), [ui.pool]);

  const choose = (next: typeof selection) => setSelection(next);
  const bridgePresent = hasResolveBridge(window.mvhubResolve);
  const different = bridgePresent && panel.current?.state === "ok" && panel.target?.state === "ok"
    && (panel.current.resolve_project_id !== panel.target.resolve_project_id || panel.current.bin_id !== panel.target.bin_id);
  const checking = panel.current && panel.current.state !== "ok";
  const sideShown = !ui.pool.sideHidden || !cut; // 닫는 단추는 풀 머리줄에만 있다 — 풀이 없을 때는 늘 보인다

  return <div className="resolve-panel">
    <header className="resolve-panel-head">
      <strong>MV Hub <span>{t("리졸브")}</span></strong>
      <div className="resolve-panel-status" role="status">{!bridgePresent ? t(BRIDGE_MISSING) : <>{panel.notice || `${t("리졸브 빈")}: ${t("확인 중")}`}{checking && <span> · {t("확인 중")}</span>}</>}</div>
      {bridgePresent && <p>{t("이 창이 리졸브 미디어 풀의 지금 빈을 고른 컷으로 바꿉니다")}</p>}
      {different && <div className="resolve-panel-warning">{t("리졸브 지금 빈이 선택한 컷과 다릅니다")}: {lastName(cut || episode)} <button type="button" onClick={() => panel.align()}>{t("맞추기")}</button></div>}
      {bridgePresent && !bridgeCompatible(window.mvhubResolve, panel.identity) && <div className="resolve-panel-warning">{t(PROTOCOL_MISMATCH)}</div>}
    </header>
    <div className="resolve-panel-body">
      {sideShown && <aside className="rp-side">
        <Bins projects={projects.projects} openProject={selection.project} roots={projects.tree.roots} episode={episode} cut={cut}
          onProject={id => { if (id !== selection.project) choose({ project: id, episode: "", cut: "" }); }}
          // 이미 고른 에피소드를 다시 누르면 그사이 생긴 컷 빈도 만든다
          onEpisode={path => { if (path === episode && !cut) panel.align(cutNodes.map(node => node.path)); else choose({ project: selection.project, episode: path, cut: "" }); }}
          onCut={path => choose({ project: selection.project, episode: parentOf(path), cut: path })} />
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
      </aside>}
      <main className="rp-main" aria-label={t("리졸브 상태")}>
        <div className="rp-view">
          {(projects.tree.note || list.error) && <p role="alert" className="rp-note">{projects.tree.note || list.error}</p>}
          {cut ? <EditPool viewOnly title={[lastName(episode), lastName(cut)].filter(Boolean).join(" / ")} items={poolItems} picked={NO_PICK}
              ui={poolUi} onUi={patch => { const { view, size, sort } = { ...ui.pool, ...patch }; patchUi({ pool: { ...ui.pool, view, size, sort } }); }}
              authKey={panel.authKey} listState={list.state} listStartedAt={list.startedAt} notice={null} pass={pass}
              onPick={noop} onPickMany={noop} onOpen={noop} onCompare={noop} resolve={NO_SEND} onClearPicked={noop} onMenu={noop}
              onFolder={noop} onCardDrag={noop} sideOpen={sideShown} onToggleSide={() => patchUi({ pool: { ...ui.pool, sideHidden: !ui.pool.sideHidden } })} />
            : episode ? <EpisodeTiles title={lastName(episode)} cuts={cutNodes} onCut={path => choose({ project: selection.project, episode, cut: path })} />
              : <p className="rp-empty-note">{t("왼쪽에서 에피소드나 컷을 고르세요")}</p>}
        </div>
        {bridgePresent && <div className="rp-alerts">
          {!panel.identity?.writer && <p>{t("다른 MV 창이 리졸브를 맡고 있습니다")} <button type="button" className="rp-act" onClick={() => void panel.takeover()}>{t("넘겨받기")}</button></p>}
          {!!panel.stage?.deferred && <p>{t("새 공유물")} {panel.stage.deferred} · {t("리졸브 지금 빈이 선택한 컷과 다릅니다")} <button type="button" className="rp-act" onClick={() => panel.align()}>{t("맞추기")}</button></p>}
          {!!panel.stage?.items?.filter(item => item.state === "same_file_exists").length && <p>{t("같은 파일 항목이 이미 있습니다")} {panel.stage.items.filter(item => item.state === "same_file_exists").length}</p>}
          {panel.stage?.capped && <p>{t("앞 200개만 띄웁니다 — 이 컷에서는 지우지 않습니다")}</p>}
          {!!panel.stage?.unexpected_imports && <p>{t("가져오기가 어긋난 항목")} {panel.stage.unexpected_imports}{t("개 — 손대지 않았습니다")}</p>}
          {panel.failures.map((failure, index) => <p role="alert" key={index}>{failure}</p>)}
          {panel.canRetry && <button type="button" className="rp-act" onClick={panel.retry}>{t("다시")}</button>}
        </div>}
        {bridgePresent && <p className="rp-foot">
          {t("띄움")} {panel.stage?.items?.filter(item => ["staged", "present"].includes(item.state)).length || 0} · {t("쓰인 것")} {panel.current?.used ? panel.current.used.length : t("확인 중")} · {t("NAS로 옮김")} {panel.moved} · {t("다른 허브")} {panel.counts.other_owner} · {t("확인 필요")} {panel.counts.needs_attention}
        </p>}
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
