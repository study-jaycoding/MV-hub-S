// 공통 폴더 트리 뷰 — 생성탭/어셋탭/관리자창이 같은 시각 언어를 공유한다.
import { useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type MouseEvent } from "react";
import { DRAG_TYPES } from "../../lib/dragTypes";
import { useDragEndReset } from "../../lib/useDragEndReset";
import { useT } from "../../lib/i18n";
import type { FolderReviewCounts } from "../../types";
import { FolderReviewCount } from "./FolderReviewCount";

// 폴더 줄이 받는 끌기 — 생성물 카드(여럿·하나). 놓는 쪽(onDropFolder)이 읽는 것과 같다.
const GENERATION_DRAG_TYPES: string[] = [DRAG_TYPES.generationList, DRAG_TYPES.generation];

/** 줄 표시 세 가지 — 생성 라임·보기 파랑·다빈치 빨강(Jay 2026-10-31). 보기는 생성 위치와 갈렸을 때만 따로 뜬다(판정은 ProjectSection). */
type RowTone = "see" | "gen" | "dv";
// '생성'은 새 생성의 기본 위치다 — 재생성은 원본 폴더로, 씬 Set 에 이어 만든 것은 그 Set 의 폴더로 간다(Codex 8A 리뷰)
const SIDE_MARK_TITLE = {
  see: "지금 목록이 보는 폴더",
  gen: "새 생성이 들어갈 기본 위치 — 재생성은 원본 폴더로, 씬의 Set 에 이어 만든 것은 그 Set 의 폴더로 갑니다",
  dv: "다빈치 확인 위치 — 생성 목적지는 변경하지 않습니다",
} as const;
export function SideMark({ kind }: { kind: RowTone }) {
  const t = useT();
  return (
    <span className={"side-mark " + kind} role="img" title={t(SIDE_MARK_TITLE[kind])}>
      <svg viewBox="0 0 16 16" aria-hidden="true">
        {kind === "see" && <>
          <path d="M1.2 8S3.8 3.2 8 3.2 14.8 8 14.8 8 12.2 12.8 8 12.8 1.2 8 1.2 8Z" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <circle cx="8" cy="8" r="2.1" fill="currentColor" />
        </>}
        {kind === "gen" && <path d="M8 .8l1.9 5.3L15.2 8l-5.3 1.9L8 15.2l-1.9-5.3L.8 8l5.3-1.9z" fill="currentColor" />}
        {kind === "dv" && <>
          <rect x="1.3" y="2.6" width="13.4" height="10.8" rx="2.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path d="M6.3 5.5l4.4 2.5-4.4 2.5z" fill="currentColor" />
        </>}
      </svg>
    </span>
  );
}

const MAX_BARS = 4; // 하위 폴더 앞 막대 — 아래 단계 수만큼, 5단계 이상도 4개(Jay 2026-10-31)

/** 이 폴더 아래 단계 수 — 막대 수와 글자 크기를 정한다. */
function levelsBelow(node: FolderTreeItem): number {
  return (node.children || []).reduce((most, child) => Math.max(most, levelsBelow(child) + 1), 0);
}

/** 글자 크기 — 깊이별 15·13, 트리의 맨 밑 단계는 늘 11(Jay 2026-10-31). 트리 전체 단계로 정해 접고 펴도 크기가 안 바뀐다. */
function rowSize(depth: number, treeLevels: number) {
  if (depth > 1 || depth === treeLevels - 1) return 11;
  return depth === 0 ? 15 : 13;
}

/** 고른 줄 연결 — 앞쪽 세로선들이 내려와 가로선에 닿고 색 바탕까지 이어진다. 가로선 아래로는 세로선이 없어 뒤의 라임 선을 가린다(Jay 2026-10-31). */
function RowLink({ depth, branch }: { depth: number; branch: boolean }) {
  const width = branch ? depth * 10 - 9.5 : 8 + (depth - 1) * 10; // 맨 앞 선 자리부터 색 바탕 왼쪽까지
  const lines = Array.from({ length: depth }, (_, i) => ({ left: 13.5 + i * 10, height: 8 + (depth - 1 - i) * 5 }));
  return (
    <>
      {lines.map(({ left, height }) => <i key={left} className="folder-tree-mask" style={{ left, height: `calc(50% + ${height}px)` }} />)}
      <i className="folder-tree-link">
        <i className="hline" style={{ width }} />
        {lines.map((line) => <i key={line.left} className="vline" style={line} />)}
      </i>
    </>
  );
}

export interface FolderTreeItem {
  name: string;
  path: string;
  count?: number | null; // 이 폴더(하위 포함)의 카탈로그 생성물 수. null = 아직 조회 전
  fileCount?: number | null; // 폴더 안 실제 파일 수(디스크). count 와 다를 때만 흐리게 덧붙는다
  newCount?: number | null; // 마지막 방문 이후 새로 공유된 개수(팀 탭) — 라임 배지
  reviewCounts?: FolderReviewCounts | null;
  children?: FolderTreeItem[];
  virtual?: boolean; // 디스크에 없는 논리 폴더(팀 데이터의 folder_path로 합성) — 표식만 다르게
}

export function FolderTreeView({
  nodes,
  selectedPath = "",
  viewedPath,
  seePath,
  genRows = false,
  expanded,
  onToggle,
  onSelect,
  onOpenTab,
  onDropFolder,
  onDragFolder,
  isDisabled,
  onRowKeyDown,
  onContextMenu,
  scroll = false,
  className = "",
}: {
  nodes: FolderTreeItem[];
  selectedPath?: string;
  viewedPath?: string; // 외부 확인 위치 — 생성 목적지(selectedPath)와 독립
  seePath?: string; // 목록이 보는 폴더 — 생성 위치와 갈렸을 때만 온다
  // 고른 줄 = 생성 위치, 확인 줄 = 다빈치인 트리(사이드바). 그 밖의 자리(편집·어셋·관리자)는 생성 위치가 없어 둘 다 보기 파랑이다.
  genRows?: boolean;
  expanded?: Set<string>;
  onToggle?: (path: string) => void;
  onSelect: (path: string) => void;
  onOpenTab?: (path: string) => void;
  // 카드를 이 폴더로 드래그해 놓으면 호출(드롭). 지정 시 폴더 행이 드롭 타깃이 된다.
  onDropFolder?: (path: string, e: DragEvent) => void;
  // 이 폴더를 캔버스 Set 노드로 끌기 시작할 때 호출.
  onDragFolder?: (path: string, e: DragEvent) => void;
  // 이 폴더가 비활성(생략)인가 — true 면 회색 표시.
  isDisabled?: (path: string) => boolean;
  // 폴더 행 포커스 상태에서 키 입력(예: d 로 비활성 토글).
  onRowKeyDown?: (path: string, e: KeyboardEvent) => void;
  // 폴더 행 우클릭(브라우저 기본 메뉴 대신). 지정한 사용처(사이드바)만 — 선택(onSelect)은 부르지 않는다.
  onContextMenu?: (path: string, name: string, depth: number, e: MouseEvent) => void;
  scroll?: boolean;
  className?: string;
}) {
  if (!nodes.length) return null;
  const treeLevels = Math.max(...nodes.map(levelsBelow)) + 1;
  return (
    <div className={"folder-tree" + (scroll ? " scroll-15" : "") + (className ? ` ${className}` : "")}>
      {nodes.map((node) => (
        <FolderTreeRow
          key={node.path || node.name}
          node={node}
          depth={0}
          treeLevels={treeLevels}
          selectedPath={selectedPath}
          viewedPath={viewedPath}
          seePath={seePath}
          genRows={genRows}
          expanded={expanded}
          onToggle={onToggle}
          onSelect={onSelect}
          onOpenTab={onOpenTab}
          onDropFolder={onDropFolder}
          onDragFolder={onDragFolder}
          isDisabled={isDisabled}
          onRowKeyDown={onRowKeyDown}
          onContextMenu={onContextMenu}
        />
      ))}
    </div>
  );
}

function FolderTreeRow({
  node,
  depth,
  treeLevels,
  selectedPath,
  viewedPath,
  seePath,
  genRows,
  expanded,
  onToggle,
  onSelect,
  onOpenTab,
  onDropFolder,
  onDragFolder,
  isDisabled,
  onRowKeyDown,
  onContextMenu,
}: {
  node: FolderTreeItem;
  depth: number;
  treeLevels: number;
  selectedPath: string;
  viewedPath?: string;
  seePath?: string;
  genRows: boolean;
  expanded?: Set<string>;
  onToggle?: (path: string) => void;
  onSelect: (path: string) => void;
  onOpenTab?: (path: string) => void;
  onDropFolder?: (path: string, e: DragEvent) => void;
  onDragFolder?: (path: string, e: DragEvent) => void;
  isDisabled?: (path: string) => boolean;
  onRowKeyDown?: (path: string, e: KeyboardEvent) => void;
  onContextMenu?: (path: string, name: string, depth: number, e: MouseEvent) => void;
}) {
  const t = useT();
  const children = node.children || [];
  const hasChildren = children.length > 0;
  const canToggle = hasChildren && !!onToggle;
  const controlled = !!expanded && !!onToggle;
  const open = !hasChildren || (controlled ? expanded.has(node.path) : true);
  const selected = selectedPath === node.path;
  const viewed = viewedPath === node.path;
  const seeing = seePath === node.path;
  const selectedTone: RowTone = genRows ? "gen" : "see";
  const viewedTone: RowTone = genRows ? "dv" : "see";
  // 줄 색은 다빈치 → 생성 → 보기 순이고, 앞 아이콘은 제 자리를 지킨다 — 다빈치가 겹치면 그 아이콘만 이름 뒤에 붙는다(Jay 2026-10-31).
  const tone = viewed ? viewedTone : selected ? selectedTone : seeing ? "see" : undefined;
  const leadMark = selected ? selectedTone : seeing ? "see" : tone;
  const otherMark = viewed && leadMark !== viewedTone ? viewedTone : undefined;
  // 접힌 폴더의 막대는 그 안의 고른 줄 색을 받는다. 없으면 펼침 라임·접힘 회색.
  const holds = (path?: string) => !open && !!path && (node.path === "" || path.startsWith(node.path + "/"));
  const barTone = tone ?? (holds(viewedPath) ? viewedTone : holds(selectedPath) ? selectedTone : holds(seePath) ? "see" : open ? "gen" : undefined);
  const disabled = isDisabled ? isDisabled(node.path) : false;
  const count = node.count || 0;
  // 배지에는 생성물 수만 둔다(좁은 사이드바). 폴더의 실제 파일 수는 호버 설명에 덧붙여,
  // '폴더엔 파일이 있는데 카탈로그엔 없다'를 확인할 수 있게 한다.
  const fileCount = node.fileCount ?? null;
  const countHint =
    node.count === null || fileCount === null
      ? ""
      : `\n생성물 ${count}개 · 폴더 파일 ${fileCount}개`;
  const [dropOver, setDropOver] = useState(false);
  useDragEndReset(dropOver, () => setDropOver(false)); // 이 줄 위에서 끌기를 취소하면 dragleave 가 오지 않는다
  const folderDraggingRef = useRef(false);
  const dragReleaseRef = useRef<number | undefined>(undefined); // 그 깃발을 내리는 예약(onDragEnd) — 새 누름이 거둔다
  // 하위가 있는 부모 폴더(예 ep001)는 드롭 대상에서 제외 — 말단 폴더(c0010 등)에만 담는다.
  //  받는 것은 생성물 카드뿐이다 — 그 밖의 끌기(탐색기의 파일 등)에는 '놓을 수 있음'을 보이지 않는다(놓아도 아무 일이 없었다).
  const dropProps = onDropFolder && !hasChildren
    ? {
        onDragOver: (e: DragEvent) => {
          if (!GENERATION_DRAG_TYPES.some((type) => e.dataTransfer.types.includes(type))) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          if (!dropOver) setDropOver(true);
        },
        onDragLeave: () => setDropOver(false),
        onDrop: (e: DragEvent) => {
          e.preventDefault();
          e.stopPropagation();
          setDropOver(false);
          onDropFolder(node.path, e);
        },
      }
    : {};
  return (
    <div className="folder-tree-node">
      <button
        type="button"
        className={
          `folder-tree-row fs${rowSize(depth, treeLevels)}` +
          (depth === 0 ? " root" : "") +
          (hasChildren ? " branch" : "") +
          (hasChildren && open ? " open" : "") +
          (count > 0 ? " has" : "") +
          (selected ? " selected" : "") +
          (viewed ? " viewed-resolve" : "") +
          (tone ? ` state st-${tone}` : "") +
          (disabled ? " disabled" : "") +
          (node.virtual ? " virtual" : "") +
          (dropOver ? " drop-over" : "")
        }
        // 들여쓰기는 인라인으로 — 줄이 button 이라 담기 메뉴 같은 곳의 'button' 규칙이 padding 을 덮어쓴다.
        style={{ "--tree-depth": depth, paddingLeft: 8 + depth * 10 } as CSSProperties}
        data-resolve-viewed={viewed || undefined}
        title={
          (node.virtual
            ? `${node.path} (팀 데이터 폴더 — 내 디스크엔 없음)`
            : node.path || node.name) + countHint
        }
        onClick={(e) => {
          e.stopPropagation();
          // 일부 브라우저는 HTML5 drag 종료 뒤 click까지 발화한다. Set으로 끌었는데
          // 폴더 필터 선택까지 되어 캔버스가 닫히는 일을 막는다.
          if (folderDraggingRef.current) {
            folderDraggingRef.current = false; // 삼키는 것은 그 끌기에 딸린 한 번이다
            e.preventDefault();
            return;
          }
          onSelect(node.path);
        }}
        // 새 누름이다 — 앞 끌기에 딸린 click 은 이미 지나갔다. 깃발을 타이머(아래 onDragEnd)로만 내리면, 끌어 놓은 직후 타이머가 돌기 전에
        //  누른 이 폴더가 안 골라진다(입력은 타이머보다 먼저 처리된다 — Codex 코드 리뷰). 끌기는 이 누름 뒤의 dragstart 가 다시 세운다.
        //  앞 끌기가 예약해 둔 해제도 거둔다 — 남겨 두면 곧바로 시작한 다음 끌기 도중에 그 타이머가 깃발을 내려, 끌기에 딸린 click 이 폴더를 고른다.
        onAuxClick={(e) => {
          if (e.button !== 1 || !onOpenTab) return;
          e.preventDefault();
          e.stopPropagation();
          onOpenTab(node.path);
        }}
        onMouseDown={(e) => {
          if (e.button === 1 && onOpenTab) e.preventDefault();
          folderDraggingRef.current = false;
          window.clearTimeout(dragReleaseRef.current);
        }}
        draggable={!!onDragFolder}
        onDragStart={
          onDragFolder
            ? (e) => {
                e.stopPropagation();
                folderDraggingRef.current = true;
                onDragFolder(node.path, e);
              }
            : undefined
        }
        onDragEnd={
          onDragFolder
            ? () => {
                window.clearTimeout(dragReleaseRef.current);
                dragReleaseRef.current = window.setTimeout(() => {
                  folderDraggingRef.current = false;
                }, 0);
              }
            : undefined
        }
        onKeyDown={(e) => {
          // 키보드만으로도 펼치고 접는다 — 펼침표(▸)는 글자라 Tab 이 닿지 않아, 접힌 폴더의 하위에는 갈 길이 없었다(조작 규칙 51).
          //  트리의 관례대로 → 펼치기 · ← 접기(WAI-ARIA tree). 고르기(Enter·Space)는 그대로 단추의 것이다.
          if (canToggle && ((e.key === "ArrowRight" && !open) || (e.key === "ArrowLeft" && open))) {
            e.preventDefault();
            e.stopPropagation();
            onToggle?.(node.path);
            return;
          }
          if (!onRowKeyDown) return;
          e.stopPropagation(); // 전역 카드선택 단축키(d 등)와 충돌 방지
          onRowKeyDown(node.path, e);
        }}
        onContextMenu={
          onContextMenu
            ? (e) => {
                e.preventDefault(); // 브라우저 기본 메뉴 대신 우리 메뉴 — 선택·드래그 상태는 건드리지 않는다
                e.stopPropagation();
                onContextMenu(node.path, node.name, depth, e);
              }
            : undefined
        }
        {...dropProps}
      >
        {hasChildren ? (
          <span
            className={"folder-tree-slot folder-tree-bars" + (canToggle ? " toggle" : "") + (barTone ? ` st-${barTone}` : "")}
            title={canToggle ? (open ? "접기" : "펴기") : undefined}
            onClick={(e) => {
              e.stopPropagation();
              if (onToggle) onToggle(node.path);
            }}
          >
            {Array.from({ length: Math.min(levelsBelow(node), MAX_BARS) }, (_, i) => <i key={i} />)}
          </span>
        ) : (
          <span className="folder-tree-slot">{leadMark && <SideMark kind={leadMark} />}</span>
        )}
        <span className="folder-tree-name">{node.name}</span>
        {hasChildren && leadMark && <SideMark kind={leadMark} />}
        {otherMark && <SideMark kind={otherMark} />}
        {node.virtual && <span className="folder-tree-nodisk">{t("폴더 없음")}</span>}
        <span className="folder-tree-fill" />
        {(node.newCount || 0) > 0 && (
          <span className="folder-tree-newcount" title="마지막 방문 이후 새로 공유됨">
            +{node.newCount}
          </span>
        )}
        {count > 0 && (node.reviewCounts !== undefined ?
          <FolderReviewCount counts={node.reviewCounts} total={count} /> :
          <span className="folder-tree-count">{count}</span>
        )}
        {tone && depth > 0 && <RowLink depth={depth} branch={hasChildren} />}
      </button>
      {hasChildren && open && (
        <div className="folder-tree-children" style={{ "--tree-depth": depth } as CSSProperties}>
          {children.map((child) => (
            <FolderTreeRow
              key={child.path || child.name}
              node={child}
              depth={depth + 1}
              treeLevels={treeLevels}
              selectedPath={selectedPath}
              viewedPath={viewedPath}
              seePath={seePath}
              genRows={genRows}
              expanded={expanded}
              onToggle={onToggle}
              onSelect={onSelect}
              onOpenTab={onOpenTab}
              onDropFolder={onDropFolder}
              onDragFolder={onDragFolder}
              isDisabled={isDisabled}
              onRowKeyDown={onRowKeyDown}
              onContextMenu={onContextMenu}
            />
          ))}
        </div>
      )}
    </div>
  );
}
