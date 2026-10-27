// 편집 탭 왼쪽 — 프로젝트와 폴더 트리에서 시퀀스(컷 폴더들을 담은 폴더)를 고른다.
// 라이브러리 사이드바(ProjectSection)를 쓰지 않는다: 그쪽은 폴더 클릭이 '생성 목적지'를 서버에 저장한다.
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { KEY_COLORS } from "../../lib/appConstants";
import type { PoolFilter } from "../../lib/editTimelineStore";
import { pressStartedCovered } from "../../lib/keyGate";
import type { Project } from "../../types";
import { folderConfirmText, type FolderMenuKind } from "../../lib/folderContextMenu";
import { useT } from "../../lib/i18n";
import type { EditTree } from "../../lib/useEditSequence";
import { ColorFilterDots } from "../common/ColorFilterDots";
import { FolderTreeView } from "../common/FolderTreeView";
import { ResizableSidebar } from "../common/ResizableSidebar";
import type { PoolCreator } from "./EditPool";
import { EditFolderMenu } from "./EditTrackMenu";

const COLOR_DOTS = [{ k: "r", hex: KEY_COLORS.r }, { k: "g", hex: KEY_COLORS.g }, { k: "b", hex: KEY_COLORS.b }]; // 공유 탭 사이드바와 같은 세 색

// 왼쪽 아래 '📌 컬러 · 전역 태그 · 생성자'(Jay 2026-10-23) — 공유 탭 사이드바 아래 묶음과 같은 모양(같은 클래스)으로 미디어 풀의 카드를 거른다.
//  open = 펼침(처음엔 접힘) · creators·autoTags = 이 시퀀스의 공유물에서 센 것(EditPool.poolFacets)
export interface EditSideFilter {
  open: boolean;
  onToggle: () => void;
  value: PoolFilter;
  onChange: (next: PoolFilter) => void;
  creators: PoolCreator[];
  autoTags: string[];
}

// 고른 폴더까지 가는 길은 펼쳐 둔다.
function ancestors(path: string): string[] {
  const parts = path.split("/");
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

export function EditSidebar({
  projects,
  projectsState,
  openProject,
  onOpenProject,
  tree,
  seq,
  cut,
  offCuts,
  freshByProject,
  onPickFolder,
  onReload,
  onGrabFocus,
  onFolderAction,
  filter,
}: {
  filter: EditSideFilter;
  projects: Project[];
  projectsState: "loading" | "ok" | "error";
  openProject: string | null;
  onOpenProject: (projectId: string | null) => void;
  tree: EditTree;
  seq: string; // 열린 프로젝트에서 고른 시퀀스 폴더(없으면 "")
  cut: string; // 재생헤드가 있는 컷(없으면 "")
  offCuts: ReadonlySet<string>; // 비활성 컷(폴더) — 다른 탭의 사이드바처럼 회색으로
  // 프로젝트 행의 +N — 공유 & 리뷰 사이드바와 같은 표시다(폴더 행의 +N·★최종·R보류는 트리 노드에 실려 온다).
  freshByProject: Readonly<Record<string, number>>;
  onPickFolder: (path: string) => void;
  onReload: () => void;
  onGrabFocus: () => void; // 여기를 누르면 편집 화면이 키를 받게 초점을 옮긴다
  // 폴더 우클릭 메뉴의 실행 — 공유 저장 · 최종 저장 · 원본 위치 열기(앱의 것 그대로: 공유 & 리뷰 탭의 폴더 메뉴와 같은 길)
  onFolderAction: (kind: FolderMenuKind, projectId: string, path: string, name: string) => void | Promise<void>;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(ancestors(seq)));
  useEffect(() => {
    if (seq) setExpanded((prev) => (prev.has(seq) ? prev : new Set([...prev, ...ancestors(seq)])));
  }, [seq]);
  // 폴더 우클릭 메뉴(Jay 2026-10-08) — 펼쳐 둔 프로젝트의 폴더다. 프로젝트를 바꾸면 닫는다. 닫히면 편집 화면이 다시 키를 받는다.
  const [folderMenu, setFolderMenu] = useState<{ path: string; name: string; depth: number; x: number; y: number } | null>(null);
  useEffect(() => setFolderMenu(null), [openProject]);
  const closeFolderMenu = () => {
    setFolderMenu(null);
    onGrabFocus();
  };
  const folderAct = (kind: FolderMenuKind) => {
    const menu = folderMenu;
    closeFolderMenu();
    if (!menu || !openProject) return;
    // 저장은 묻고 한다(공유 & 리뷰 탭과 같은 물음) — 원본 위치 열기는 바로
    if (kind !== "open-folder" && !window.confirm(folderConfirmText(kind, menu.name))) return;
    void onFolderAction(kind, openProject, menu.path, menu.name);
  };
  // 단추가 초점을 가져가지 않게 한다 — 누른 뒤에도 Space·J·K·L 이 재생으로 간다.
  const keepFocus = (event: ReactMouseEvent) => event.preventDefault();
  // 위에 뜬 메뉴(폴더 우클릭 메뉴 등)를 닫는 누름은 고르기가 아니다(조작 규칙 4, 58회차) — 누름의 시작에 적어 두고 뒤따르는 click 을
  //  여기서 거둔다(click 때는 이미 메뉴가 닫혀 있다). 이 칸 DOM 안의 누름·click 만 센다 — 이 칸 안에서 포털(body 에 그리는 창)을 열게
  //  되어도 그 안의 누름은 세지 않게(React 이벤트는 포털에서도 부모를 지나온다. 지금의 폴더 메뉴는 이 칸의 형제라 지나지 않는다).
  //  키보드의 click(detail 0)도 거두지 않는다.
  const coveredPressRef = useRef(false);
  const inside = (event: ReactMouseEvent<HTMLDivElement>) => event.currentTarget.contains(event.target as Node);
  const notePress = (event: ReactMouseEvent<HTMLDivElement>) => {
    coveredPressRef.current = event.button === 0 && inside(event) && pressStartedCovered();
    onGrabFocus();
  };
  const swallowCoveredClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!coveredPressRef.current || event.detail === 0 || !inside(event)) return;
    coveredPressRef.current = false;
    event.stopPropagation();
  };
  const value = filter.value;
  const change = (patch: Partial<PoolFilter>) => filter.onChange({ ...value, ...patch });
  const activeCount = value.colors.length + value.autoTags.length + Number(value.final) + Number(value.hideGray) + Number(!!value.creator);

  return (
    <ResizableSidebar>
      <div className="sidebar-main ed-side" onMouseDownCapture={notePress} onClickCapture={swallowCoveredClick} onMouseDown={keepFocus}>
        <section className="project-section">
          <div className="project-tree-section">
            <h4>{t("프로젝트")}</h4>
            <div className="project-tree-scroll">
              <div className="proj-list">
                {projectsState === "loading" && !projects.length && (
                  <div className="side-folder-note">{t("프로젝트 로딩...")}</div>
                )}
                {projectsState === "error" && (
                  <div className="side-folder-note error">
                    {t("프로젝트를 불러오지 못했습니다.")}{" "}
                    <button type="button" className="ed-link" onClick={onReload}>{t("다시 시도")}</button>
                  </div>
                )}
                {projects.map((project) => {
                  const open = project.id === openProject;
                  return (
                    <div key={project.id} className={"proj-tree-wrap" + (open ? " on" : "")}>
                      <button
                        type="button"
                        className={"proj-row" + (open ? " on" : "")}
                        onClick={() => onOpenProject(open ? null : project.id)}
                      >
                        <span className="proj-fold">{open ? "▾" : "▸"}</span>
                        <span className="proj-drag-handle" />
                        <span className="proj-name">{project.name}</span>
                        {(freshByProject[project.id] || 0) > 0 && (
                          <span className="proj-newcount" title={t("마지막 확인 이후 새로 공유됨")}>
                            +{freshByProject[project.id]}
                          </span>
                        )}
                      </button>
                      {open && tree.state === "loading" && <div className="side-folder-note">{t("폴더 로딩...")}</div>}
                      {open && tree.note && (
                        <div className={"side-folder-note" + (tree.state === "error" ? " error" : "")}>
                          {tree.note}{" "}
                          <button type="button" className="ed-link" onClick={onReload}>{t("다시 시도")}</button>
                        </div>
                      )}
                      {open && tree.state === "ready" && (
                        tree.roots.length ? (
                          <FolderTreeView
                            nodes={tree.roots}
                            selectedPath={seq}
                            viewedPath={cut || undefined}
                            expanded={expanded}
                            onToggle={(path) =>
                              setExpanded((prev) => {
                                const next = new Set(prev);
                                if (!next.delete(path)) next.add(path);
                                return next;
                              })
                            }
                            onSelect={onPickFolder}
                            isDisabled={(path) => offCuts.has(path)}
                            onContextMenu={(path, name, depth, event) =>
                              setFolderMenu({ path, name, depth, x: event.clientX, y: event.clientY })}
                            className="sidebar-folder-tree"
                          />
                        ) : (
                          <div className="side-folder-note">{t("폴더가 없습니다.")}</div>
                        )
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </section>
      </div>
      <button type="button" className={"sidebar-foot-toggle" + (filter.open ? " on" : "")} aria-expanded={filter.open}
        title={filter.open ? t("접기 — 폴더를 더 넓게 본다") : t("펼치기")} onMouseDown={keepFocus} onClick={filter.onToggle}>
        <span className="sidebar-foot-pin">📌</span>
        {t("컬러")} · {t("전역 태그")} · {t("생성자")}
        {/* 접어 둔 채 거르는 중이면 켠 개수 — 풀이 왜 줄었는지 보이게 */}
        {!filter.open && activeCount > 0 && (
          <span className="ed-foot-count" title={t("미디어 풀을 거르는 중")}>{activeCount}</span>
        )}
      </button>
      <div className="sidebar-foot" hidden={!filter.open} onMouseDown={keepFocus}>
        <section>
          <h4>{t("컬러")}</h4>
          <div className="color-dots">
            <ColorFilterDots
              colorDots={COLOR_DOTS}
              activeColors={new Set(value.colors)}
              onToggleColor={(hex) => change({ colors: value.colors.includes(hex) ? value.colors.filter((item) => item !== hex) : [...value.colors, hex] })}
              grayOn={value.hideGray}
              onToggleGray={() => change({ hideGray: !value.hideGray })}
              finalOnly={value.final}
              onToggleFinal={() => change({ final: !value.final })}
            />
          </div>
        </section>
        <section>
          <h4>{t("전역 태그")}</h4>
          <div className="chips">
            {!filter.autoTags.length && <span className="muted">{t("없음")}</span>}
            {filter.autoTags.map((tag) => {
              const on = value.autoTags.includes(tag);
              return (
                <span key={tag} className={"auto-tag-chip" + (on ? " on" : "")}>
                  <button type="button" className="auto-tag-name" title={on ? t("필터 해제") : t("이 전역 태그가 붙은 것만 보기")}
                    onClick={() => change({ autoTags: on ? value.autoTags.filter((item) => item !== tag) : [...value.autoTags, tag] })}>
                    {tag}
                  </button>
                </span>
              );
            })}
          </div>
        </section>
        {filter.creators.length > 0 && (
          <section>
            <h4>{t("생성자")}</h4>
            {filter.creators.map((creator) => (
              <div key={creator.key} className={"creator-row" + (value.creator === creator.key ? " on" : "")}>
                <button type="button" className="creator-pick"
                  onClick={() => change({ creator: value.creator === creator.key ? null : creator.key })}>
                  <span className="creator-dot" style={{ background: creator.mine ? "var(--accent)" : "#4ade80" }} />
                  <span className="creator-name">{creator.name || (creator.mine ? t("나") : t("팀원"))}</span>
                  <span className="creator-count">{creator.count}</span>
                </button>
              </div>
            ))}
          </section>
        )}
      </div>
      {folderMenu && (
        <EditFolderMenu x={folderMenu.x} y={folderMenu.y} name={folderMenu.name} path={folderMenu.path} depth={folderMenu.depth}
          // 원격 접속에서 서버 PC 의 탐색기를 열지 않는다(공유 & 리뷰 탭과 같은 기준 — 최종 판정은 백엔드가 한다)
          canOpen={["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname)}
          onAct={folderAct} onClose={closeFolderMenu} />
      )}
    </ResizableSidebar>
  );
}
