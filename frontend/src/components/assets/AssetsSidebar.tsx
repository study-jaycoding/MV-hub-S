import { useMemo, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { api } from "../../api";
import { clampMenuPosition } from "../../lib/folderContextMenu";
import { useT } from "../../lib/i18n";
import { reportSourceLocationError } from "../../lib/sourceLocationFeedback";
import { useEscapeClose } from "../../lib/useEscapeClose";
import { useOutsideMouseDown } from "../../lib/useOutsideMouseDown";
import type { AssetMeta, AssetNode } from "../../types";
import { SideMark } from "../common/FolderTreeView";
import { WorkspaceMark } from "../common/WorkspaceMark";
import { FolderIcon } from "../FolderIcon";
import { assetFileCount, FolderTree } from "./FolderTree";
import { FOLDER_KIND_TONE, type AssetFolderKind, type AssetTypeFilter } from "./assetsViewModel";

// 폴더 우클릭 메뉴 크기 — 화면 가장자리 보정용(.folder-ctx-menu 최소 폭 200 · 머리 24 + 줄 30 + 안쪽 여백·간격·테두리)
const FOLDER_MENU_W = 200;
const FOLDER_MENU_H = 70;

export function AssetsSidebar({
  project,
  projectId,
  folderKind,
  typeFilter,
  dir,
  meta,
  sourceOnly,
  onRoot,
  loading,
  tree,
  expanded,
  onToggleDir,
  onSelectDir,
  onOpenTab,
}: {
  project: string;
  projectId?: string; // PM 프로젝트 id — 마크 색이 메인과 같아진다. 수동 등록 폴더에는 없다
  folderKind: AssetFolderKind;
  typeFilter: AssetTypeFilter;
  dir: string;
  meta: Record<string, AssetMeta>;
  sourceOnly: boolean;
  onRoot: () => void;
  loading: boolean;
  tree: AssetNode[];
  expanded: Set<string>;
  onToggleDir: (path: string) => void;
  onSelectDir: (path: string) => void;
  onOpenTab?: (path: string) => void;
}) {
  // 타입 필터 행(All/Image/Video/Audio)은 하단 바의 4점 슬라이더로 대체됐고(Jay 요청),
  // 프로젝트 선택 드롭다운은 헤더 경로 첫 자리로 갔다. typeFilter 는 트리 배지 계산용.
  const count = useMemo(() => assetFileCount(tree, typeFilter, meta, sourceOnly), [tree, typeFilter, meta, sourceOnly]);
  const missing = folderKind === "missing";
  const atRoot = dir === "" && !missing;
  const t = useT();
  // 폴더 줄 우클릭 → '원본 위치 열기'(Jay 2026-11-20 시안 B). 원격 접속에서는 서버 PC 의 탐색기를 열지 않으므로 메뉴 없이
  //  브라우저 기본 메뉴 그대로 둔다(메인 사이드바·편집 탭과 같은 기준 — 최종 판정은 백엔드 로컬 가드).
  //  닫기: Esc(초점은 연 줄로 — 안 그러면 body 로 빠져 전역 단축키로 샌다), 바깥 누름, Tab 으로 빠져나감.
  const [folderMenu, setFolderMenu] = useState<{ path: string; name: string; x: number; y: number } | null>(null);
  const folderMenuRef = useRef<HTMLDivElement>(null);
  const menuAnchorRef = useRef<HTMLElement | null>(null);
  const closeFolderMenu = (restoreFocus: boolean) => {
    setFolderMenu(null);
    if (restoreFocus) menuAnchorRef.current?.focus();
  };
  useEscapeClose(() => closeFolderMenu(true), !!folderMenu, true, true);
  useOutsideMouseDown(folderMenuRef, () => closeFolderMenu(false), !!folderMenu, undefined, true);
  const canOpenFolder = ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);
  const openFolderMenu = canOpenFolder
    ? (path: string, name: string, _depth: number, e: MouseEvent) => {
        menuAnchorRef.current = e.currentTarget as HTMLElement;
        setFolderMenu({ path, name, x: e.clientX, y: e.clientY });
      }
    : undefined;
  return (
    <aside className="assets-tree">
      <div className="proj-tree-wrap">
        {/* 맨 윗줄 = 메인 프로젝트 줄과 같은 모양 — 마크·이름·개수(Jay 2026-11-02). 개수는 어셋 파일 수다.
            프로젝트가 아닌 폴더는 프로젝트 마크 대신 폴더 아이콘을 쓰고, 찾을 수 없으면 셀 파일이 없어 개수도 뺀다. */}
        <button
          type="button"
          className={"proj-row open assets-root-row" + (missing ? " missing" : atRoot ? " state st-see" : "")}
          title={project}
          onClick={onRoot}
          onMouseDown={(e) => { if (e.button === 1 && onOpenTab) e.preventDefault(); }}
          onAuxClick={(e) => { if (e.button === 1 && onOpenTab) { e.preventDefault(); onOpenTab(""); } }}
        >
          {folderKind === "manual" || missing
            ? <FolderIcon width={18} height={15} tone={FOLDER_KIND_TONE[folderKind]} />
            : project && <WorkspaceMark label={project} id={projectId || project} />}
          <span className="proj-name">{project || "…"}</span>
          {atRoot && <SideMark kind="see" />}
          {!loading && !missing && <span className="proj-count">{count}</span>}
        </button>
        {loading ? (
          <div className="assets-loading">로딩…</div>
        ) : (
          <FolderTree
            nodes={tree}
            current={dir}
            onSelect={onSelectDir}
            onOpenTab={onOpenTab}
            expanded={expanded}
            onToggle={onToggleDir}
            typeFilter={typeFilter}
            meta={meta}
            sourceOnly={sourceOnly}
            project={project}
            onContextMenu={openFolderMenu}
          />
        )}
      </div>
      {folderMenu &&
        createPortal(
          <div
            ref={folderMenuRef}
            className="folder-ctx-menu assets-tree-menu"
            role="menu"
            style={clampMenuPosition(folderMenu.x, folderMenu.y, window.innerWidth, window.innerHeight, FOLDER_MENU_W, FOLDER_MENU_H)}
            onKeyDown={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.preventDefault()}
          >
            <div className="folder-ctx-head">
              <div className="folder-ctx-name" title={folderMenu.path}>{folderMenu.name}</div>
            </div>
            <button
              type="button"
              role="menuitem"
              autoFocus
              className="preview-menu-item"
              title={t("원본 위치 열기 — 연결된 실제 폴더를 탐색기에서 엽니다")}
              onClick={() => {
                const path = folderMenu.path;
                closeFolderMenu(true);
                api.revealAsset(project, path).catch(reportSourceLocationError);
              }}
            >
              <span className="assets-tree-menu-ico" aria-hidden="true">📂</span>
              {t("원본 위치 열기")}
            </button>
          </div>,
          document.body,
        )}
    </aside>
  );
}
