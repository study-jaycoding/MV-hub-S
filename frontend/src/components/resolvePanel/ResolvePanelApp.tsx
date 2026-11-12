import { useEffect, useMemo, useRef, useState } from "react";
import type { Generation, WorkspaceContext } from "../../types";
import { LoginScreen } from "../LoginScreen";
import { findFolder, useEditGenerations, useEditProjects } from "../../lib/useEditSequence";
import type { FolderCountTreeNode } from "../../lib/folderTreeModel";
import { useT } from "../../lib/i18n";
import { BRIDGE_MISSING, bridgeCompatible, hasResolveBridge, PROTOCOL_MISMATCH } from "../../lib/resolvePanelApi";
import { loadSavedSelection, saveSelection, useResolvePanel, type SavedSelection } from "../../lib/useResolvePanel";
import { connectProgress } from "../../lib/progressSocket";
import { useOutsideMouseDown } from "../../lib/useOutsideMouseDown";
import { useEscapeClose } from "../../lib/useEscapeClose";
import { KEY_COLORS } from "../../lib/appConstants";
import { NO_POOL_FILTER, type EditUi, type PoolFilter } from "../../lib/editTimelineStore";
import { ColorFilterDots } from "../common/ColorFilterDots";
import { FolderTreeView } from "../common/FolderTreeView";
import { ResizableSidebar } from "../common/ResizableSidebar";
import { SidebarEdgeToggle } from "../common/SidebarEdgeToggle";
import { WorkspaceMark } from "../common/WorkspaceMark";
import { EditPool, poolFacets, poolFilterPass, type PoolItem } from "../timeline/EditPool";
import "../../styles/edit-tab.css";
import "../../styles/resolve-panel.css";

const ALL_WORKSPACES: WorkspaceContext = { scope: "unknown", id: null, name: null };
const uiKey = "mvhub.resolvePanel.ui";
const REFRESH_MS = 15_000; // 실시간 연결이 끊겼을 때의 안전망 — 공유 & 리뷰 탭의 목록 확인 간격과 같다
const LIVE_DEBOUNCE_MS = 1_000; // 실시간 알림이 여러 개 와도 한 번만 다시 읽는다
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
// 트리 줄 표의 뜻 — 패널에서는 '생성 위치'가 아니라 고른 폴더·다빈치 위치다(공용 트리의 genRows 색을 빌린다)
const MARK_TITLES = { gen: "패널에서 고른 폴더 — 다빈치에 그 컷 빈을 만듭니다", dv: "다빈치가 지금 들어가 있는 빈" };

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
// 에피소드 = 생성물 있는 컷(하위가 없는 폴더)을 가진 폴더 — 누르면 그 컷 빈만 다빈치에 만든다(트리 개수라 목록 상한과 무관)
const episodeCuts = (node: FolderCountTreeNode | null) => byName(node?.children).filter(kid => !kid.children?.length && !!kid.count);

// 사이드바 맨 위 — 지금 프로젝트(마크·이름·생성물 수). 누르면 볼 수 있는 프로젝트 목록이 펼쳐진다(맨 아래 목록을 여기로, Jay 11-12).
function ProjectPicker({ projects, current, total, onPick }: {
  projects: { id: string; name: string }[]; current: string; total: number; onPick: (id: string) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useOutsideMouseDown(box, () => setOpen(false), open);
  useEscapeClose(() => setOpen(false), open, true, true);
  const now = projects.find(project => project.id === current);
  return <div className="rp-picker" ref={box}>
    <div className="rp-picker-label">{t("프로젝트")}</div>
    <button type="button" className={"rp-project" + (open ? " open" : "")} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
      {now && <WorkspaceMark label={now.name} id={now.id} />}
      <span className="rp-pname">{now?.name || t("프로젝트를 고르세요")}</span>
      {!!total && <span className="rp-pcount">{total}</span>}
      <span className="rp-caret" aria-hidden="true">▾</span>
    </button>
    {open && <div className="rp-menu" role="menu" aria-label={t("프로젝트")}>
      {projects.map(project => <button key={project.id} type="button" role="menuitemradio" aria-checked={project.id === current}
        className={"rp-item" + (project.id === current ? " on" : "")} onClick={() => { setOpen(false); onPick(project.id); }}>
        <WorkspaceMark label={project.name} id={project.id} /><span className="rp-pname">{project.name}</span>
        {project.id === current && <b aria-hidden="true">✓</b>}
      </button>)}
    </div>}
  </div>;
}

// 에피소드만 고른 때의 오른쪽 — 생성물 있는 컷 폴더 타일(누르면 그 컷을 고른다 = 다빈치도 그 빈으로)
function EpisodeTiles({ title, cuts, onCut, sideOpen, onToggleSide }: {
  title: string; cuts: FolderCountTreeNode[]; onCut: (path: string) => void; sideOpen: boolean; onToggleSide: () => void;
}) {
  const t = useT();
  return <section className="ed-pool rp-tiles-wrap">
    <div className="ed-pool-head">
      <SidebarEdgeToggle open={sideOpen} onToggle={onToggleSide} title={sideOpen ? t("필터 사이드바 닫기") : t("필터 사이드바 열기")} />
      <h3 title={title}>{title}</h3>
    </div>
    <div className="ed-pool-sub">{t("생성물 있는 컷 {count}개").replace("{count}", String(cuts.length))}</div>
    {!cuts.length && <div className="ed-pool-note">{t("이 폴더에는 생성물 있는 컷이 없습니다")}</div>}
    <div className="rp-tiles">{cuts.map(node => <button key={node.path} type="button" className="rp-tile" onClick={() => onCut(node.path)}>
      <span className="rp-ficon" aria-hidden="true" /><b>{node.name}</b><i>{node.count}</i>
    </button>)}</div>
  </section>;
}

function PanelContent({ panel }: { panel: ReturnType<typeof useResolvePanel> }) {
  const t = useT();
  const [selection, setSelection] = useState<SavedSelection>(() => loadSavedSelection(panel.davinci));
  const [ui, setUi] = useState<PanelUi>(loadUi);
  const patchUi = (patch: Partial<PanelUi>) => setUi(prev => ({ ...prev, ...patch }));
  useEffect(() => { try { localStorage.setItem(uiKey, JSON.stringify(ui)); } catch { /* 저장소가 막혀도 보기는 유지한다. */ } }, [ui]);
  const { cut, episode } = selection;
  // 사람이 고른 것만 그 다빈치 프로젝트 몫으로 저장한다(다빈치 프로젝트를 바꿔 꺼낸 것은 다시 적지 않는다)
  const choose = (next: SavedSelection) => { setSelection(next); saveSelection(panel.davinci, next); };
  // team+id일 때만 프로젝트가 제한된다 — 'unknown'은 workspace_id 없는 전체 목록이다.
  const projects = useEditProjects({ authKey: panel.authKey, workspace: ALL_WORKSPACES, projectId: selection.project || null });
  // 프로젝트 전체를 한 번 받아 두고 폴더를 바꿀 때는 다시 받지 않는다 — 2,000 상한을 넘으면(capped) 에피소드마다 받는다
  const whole = useEditGenerations({ authKey: panel.authKey, workspace: ALL_WORKSPACES, projectId: selection.project || null,
    seq: "", allWorkspaces: true, wholeProject: true });
  const capped = whole.state === "capped";
  const part = useEditGenerations({ authKey: panel.authKey, workspace: ALL_WORKSPACES, projectId: capped ? selection.project || null : null,
    seq: episode || cut || null, allWorkspaces: true });
  const list = capped ? part : whole;
  const episodeNode = useMemo(() => (episode ? findFolder(projects.tree.roots, episode) : null), [projects.tree.roots, episode]);
  const cutNodes = useMemo(() => episodeCuts(episodeNode), [episodeNode]);
  const cutPaths = cutNodes.map(node => node.path);
  const cutsKey = cutPaths.join("\0");
  const cutGens = useMemo(() => (cut ? list.gens.filter(gen => gen.folder_path === cut) : []), [list.gens, cut]);
  const pass = poolFilterPass(ui.filter, NO_GRAY);
  const filtered = cutGens.filter(gen => !pass || pass(gen));
  const ids = filtered.map(gen => gen.id).sort().join("\0");
  const bridgePresent = hasResolveBridge(window.mvhubResolve);
  // 트리를 받은 뒤에 고른다 — 컷 목록(빈을 만들 것)이 빈 채로 target 이 나가지 않게. 리졸브 안에서는 열린 다빈치 프로젝트를 안 뒤에
  //  (그 프로젝트의 저장된 선택을 꺼내기 전에 다른 프로젝트 몫으로 빈을 만들지 않게).
  const treeSettled = projects.tree.state === "ready" || projects.tree.state === "error";
  const davinciKnown = !bridgePresent || !panel.identity?.writer || !!panel.davinci;
  const ready = davinciKnown && treeSettled && (!cut || list.state === "ok" || list.state === "capped");

  // 다빈치 프로젝트가 바뀌면 그 프로젝트의 저장된 선택으로(Jay 11-12 — 다빈치 프로젝트마다 따로 기억)
  const shownFor = useRef(panel.davinci);
  const chosen = useRef("");
  useEffect(() => {
    if (!panel.davinci || panel.davinci === shownFor.current) return;
    shownFor.current = panel.davinci;
    chosen.current = ""; // 같은 폴더라도 새 다빈치 프로젝트에서 다시 고른다(훅은 앞 선택을 버렸다)
    setSelection(loadSavedSelection(panel.davinci));
  }, [panel.davinci]);
  useEffect(() => {
    if (projects.projectsState === "ok" && selection.project && !projects.projects.some(project => project.id === selection.project)) {
      choose({ project: projects.projects[0]?.id || "", episode: "", cut: "" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects.projects, projects.projectsState, selection.project]);
  // 고른 곳이 바뀔 때만 리졸브에 알린다. 같은 컷을 다시 읽어 생긴 카드는 다시 띄우기만 — 읽는 중(loading)에 선택을 풀지 않는다
  //  (풀면 앞 에피소드 정리가 새 target 보다 먼저 돈다).
  const folderKey = `${selection.project}\n${episode}\n${cut}`;
  useEffect(() => {
    if (folderKey !== chosen.current) {
      if (!cut && !episode) { if (chosen.current) { chosen.current = ""; panel.selectFolder("", "", "", []); } return; }
      if (!ready) return;
      chosen.current = folderKey;
      panel.selectFolder(selection.project, episode, cut, filtered, list.state === "capped", cutPaths);
    } else if (ready && cut) panel.updateSet(filtered, list.state === "capped");
    // 카드 목록 자체의 재생성으로 같은 곳을 다시 고르지 않는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderKey, ids, ready, list.state, panel.selectFolder, panel.updateSet]);
  // 실시간 — 에피소드에 생성물 있는 컷이 새로 생기면 다빈치 빈도 만든다(지금 빈은 지킨다)
  useEffect(() => {
    if (ready && episode && chosen.current === folderKey) panel.syncCuts(cutPaths);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cutsKey, ready, folderKey, panel.syncCuts]);
  // 미리 캐시(11-12 띄움 속도) — 에피소드 컷들의 거르기 통과 원본을 컷마다 띄움과 같은 범위(오래된 200개)로, 고른 컷 먼저
  const precacheList = useMemo(() => {
    if (!episode) return [];
    const byCut = new Map<string, Generation[]>();
    for (const gen of list.gens) if (gen.folder_path && (!pass || pass(gen))) byCut.set(gen.folder_path, [...byCut.get(gen.folder_path) || [], gen]);
    const order = cut ? [cut, ...cutPaths.filter(path => path !== cut)] : cutPaths;
    return order.map((path): [string, string[]] => [path, [...byCut.get(path) || []]
      .sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")) || a.id.localeCompare(b.id)).slice(0, 200).map(gen => gen.id)])
      .filter(([, ids]) => ids.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [episode, cut, cutsKey, list.gens, ui.filter]);
  const precacheKey = JSON.stringify(precacheList);
  useEffect(() => {
    // 목록이 비어도 부른다 — 새 판(빈 목록)이 옛 판(옛 거르기·목록)을 끝낸다(Codex 독립 리뷰)
    if (ready && episode && chosen.current === folderKey) panel.precache(selection.project, episode, precacheList);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [precacheKey, ready, folderKey, panel.precache]);
  // 다빈치에서 컷 빈에 들어가면 그 컷으로, 에피소드 빈으로 돌아오면 컷 선택을 풀고 따라간다
  useEffect(() => {
    const follow = panel.follow;
    if (follow && follow.project === selection.project && follow.episode === episode && follow.cut !== cut) {
      choose({ project: follow.project, episode: follow.episode, cut: follow.cut });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel.follow]);
  // 실시간 — 앱과 같은 실시간 연결(/ws)의 공유 동기화·완료 알림을 받으면 목록·트리 수를 다시 읽는다(1초 묶음).
  //  15초 다시 읽기는 연결이 끊겼을 때의 안전망이다(창으로 돌아올 때도 — 3초 안 중복은 건너뜀).
  const lastRefresh = useRef(0);
  const { reload: reloadWhole } = whole;
  const { reload: reloadPart } = part;
  const { reloadCounts } = projects;
  useEffect(() => {
    const refresh = (force = false) => {
      if (!force && (document.visibilityState === "hidden" || Date.now() - lastRefresh.current < 3000)) return;
      lastRefresh.current = Date.now(); reloadWhole(); reloadPart(); reloadCounts();
    };
    let live: ReturnType<typeof setTimeout> | undefined;
    const off = connectProgress(message => {
      if (message.type !== "synced" && message.status !== "done") return;
      clearTimeout(live);
      live = setTimeout(() => refresh(true), LIVE_DEBOUNCE_MS);
    }, () => refresh(true));
    const timer = window.setInterval(() => refresh(), REFRESH_MS);
    const focus = () => refresh();
    window.addEventListener("focus", focus);
    return () => { off(); clearTimeout(live); window.clearInterval(timer); window.removeEventListener("focus", focus); };
  }, [reloadWhole, reloadPart, reloadCounts]);

  const scopeGens = useMemo(() => (cut ? cutGens : episode ? list.gens.filter(gen => (gen.folder_path || "").startsWith(episode + "/")) : list.gens),
    [cut, cutGens, episode, list.gens]);
  const facets = useMemo(() => poolFacets(scopeGens), [scopeGens]);
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
  // 트리 — 고른 곳의 위 폴더까지만 펼쳐 둔다(고른 폴더 자신은 펼치지 않는다 — 한 번 누르기는 고르기만, 두 번 누르기·폴더 아이콘 = 펴고 접기)
  const [expanded, setExpanded] = useState(() => new Set(ancestors(parentOf(cut || episode))));
  useEffect(() => { setExpanded(prev => new Set([...prev, ...ancestors(parentOf(cut || episode))])); }, [cut, episode]);
  const pick = (path: string) => {
    const node = findFolder(projects.tree.roots, path);
    if (node?.children?.length) {
      // 같은 에피소드를 다시 누름 = 아무것도 안 함(두 번 누르기로 펴고 접을 때 target 이 더 나가지 않게 — 새 컷 빈은 실시간으로 생긴다)
      if (path !== episode || cut) choose({ project: selection.project, episode: path, cut: "" });
    } else choose({ project: selection.project, episode: parentOf(path), cut: path });
  };
  const total = projects.tree.roots.reduce((sum, node) => sum + (node.count || 0), 0);

  const different = bridgePresent && panel.current?.state === "ok" && panel.target?.state === "ok"
    && (panel.current.resolve_project_id !== panel.target.resolve_project_id || panel.current.bin_id !== panel.target.bin_id);
  const checking = panel.current && panel.current.state !== "ok";
  const sideShown = !ui.pool.sideHidden;
  const toggleSide = () => patchUi({ pool: { ...ui.pool, sideHidden: !ui.pool.sideHidden } });

  return <div className="resolve-panel">
    <header className="resolve-panel-head">
      <strong>MV Hub <span>{t("리졸브")}</span></strong>
      <div className="resolve-panel-status" role="status">{!bridgePresent ? t(BRIDGE_MISSING) : <>{panel.notice || `${t("리졸브 빈")}: ${t("확인 중")}`}{checking && <span> · {t("확인 중")}</span>}</>}</div>
      {bridgePresent && <p>{t("이 창이 리졸브 미디어 풀의 지금 빈을 고른 컷으로 바꿉니다")}</p>}
      {different && <div className="resolve-panel-warning">{t("리졸브 지금 빈이 선택한 컷과 다릅니다")}: {lastName(cut || episode)} <button type="button" onClick={() => panel.align(cutPaths)}>{t("맞추기")}</button></div>}
      {bridgePresent && !bridgeCompatible(window.mvhubResolve, panel.identity) && <div className="resolve-panel-warning">{t(PROTOCOL_MISMATCH)}</div>}
    </header>
    <div className="resolve-panel-body">
      {sideShown && <ResizableSidebar className="rp-side" widthKey="mvhub.resolvePanel.sideWidth" min={160} max={420} base={200}>
        <ProjectPicker projects={projects.projects} current={selection.project} total={total}
          onPick={id => { if (id !== selection.project) choose({ project: id, episode: "", cut: "" }); }} />
        <div className="rp-bins">
          {(projects.tree.state === "loading" || projects.tree.state === "idle") && !!selection.project && <div className="side-folder-note">{t("폴더를 불러오는 중")}</div>}
          {/* 다빈치 표는 고른 폴더와 다를 때만 — 같으면 공용 트리 규칙상 줄이 빨갛게 되어 고른 줄 라임(이미지 2)이 안 보인다 */}
          {projects.tree.state === "ready" && <FolderTreeView nodes={projects.tree.roots} selectedPath={cut || episode}
            viewedPath={panel.here && panel.here !== (cut || episode) ? panel.here : undefined}
            genRows markTitles={{ gen: t(MARK_TITLES.gen), dv: t(MARK_TITLES.dv) }} expanded={expanded}
            onToggle={path => setExpanded(prev => { const next = new Set(prev); if (!next.delete(path)) next.add(path); return next; })}
            onSelect={pick} className="sidebar-folder-tree" />}
        </div>
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
      </ResizableSidebar>}
      <main className="rp-main" aria-label={t("리졸브 상태")}>
        <div className="rp-view">
          {(projects.tree.note || list.error) && <p role="alert" className="rp-note">{projects.tree.note || list.error}</p>}
          {cut ? <EditPool viewOnly title={[lastName(episode), lastName(cut)].filter(Boolean).join(" / ")} items={poolItems} picked={NO_PICK}
              ui={poolUi} onUi={patch => { const { view, size, sort } = { ...ui.pool, ...patch }; patchUi({ pool: { ...ui.pool, view, size, sort } }); }}
              authKey={panel.authKey} listState={list.state} listStartedAt={list.startedAt} notice={null} pass={pass}
              onPick={noop} onPickMany={noop} onOpen={noop} onCompare={noop} resolve={NO_SEND} onClearPicked={noop} onMenu={noop}
              onFolder={noop} onCardDrag={noop} sideOpen={sideShown} onToggleSide={toggleSide} />
            : episode ? <EpisodeTiles title={lastName(episode)} cuts={cutNodes} sideOpen={sideShown} onToggleSide={toggleSide}
                onCut={path => choose({ project: selection.project, episode, cut: path })} />
              : <>
                <div className="ed-pool-head"><SidebarEdgeToggle open={sideShown} onToggle={toggleSide} title={sideShown ? t("필터 사이드바 닫기") : t("필터 사이드바 열기")} /></div>
                <p className="rp-empty-note">{t("왼쪽에서 에피소드나 컷을 고르세요")}</p>
              </>}
        </div>
        {bridgePresent && <div className="rp-alerts">
          {!panel.identity?.writer && <p>{t("다른 MV 창이 리졸브를 맡고 있습니다")} <button type="button" className="rp-act" onClick={() => void panel.takeover()}>{t("넘겨받기")}</button></p>}
          {!!panel.stage?.deferred && <p>{t("새 공유물")} {panel.stage.deferred} · {t("리졸브 지금 빈이 선택한 컷과 다릅니다")} <button type="button" className="rp-act" onClick={() => panel.align(cutPaths)}>{t("맞추기")}</button></p>}
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
