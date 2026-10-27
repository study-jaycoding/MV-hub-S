import { useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type RefObject, type UIEventHandler } from "react";
import { api } from "../../api";
import { useT } from "../../lib/i18n";
import { backgroundKeysBlocked, isTypingTarget, useLooseKeys } from "../../lib/keyGate";
import { isKeyHandled, markKeyHandled } from "../../lib/keyHandled";
import { EPISODE_CARD_WIDTH, STRIP_SHOWN } from "../../lib/episodeBoard";
import type { AssetNode } from "../../types";
import { FolderIcon } from "../FolderIcon";
import { FolderCardCoverContent, FolderCardPreview } from "../FolderCardVisuals";
import { MediaThumbnail } from "../MediaThumbnail";
import { LastViewedBadge } from "../scene/LastViewedBadge";
import type { AssetFolderGroup } from "./assetFolderGroups";
import type { AssetFolderLayout } from "./useAssetFolderTabs";
import { AssetFolderTable } from "./AssetFolderTable";
import { AssetSourcePath } from "./AssetSourcePath";

export interface AssetFolderGridProps {
  project: string;
  groups: AssetFolderGroup[];
  directFiles: AssetNode[];
  scale: number;
  fit: "cover" | "contain";
  layout: AssetFolderLayout;
  lastViewedPath?: string;
  scrollRef: RefObject<HTMLDivElement>;
  onScroll: UIEventHandler<HTMLDivElement>;
  onEnter: (path: string) => void;
  onOpenTab: (path: string) => void;
  onPreview: (file: AssetNode) => void;
}

/** 표 보기(AssetFolderTable)에 넘기는 선택·키 — 카드·목록·표가 같은 선택과 키 처리를 쓴다. */
export interface AssetFolderSelection {
  selected: string | null;
  setSelected: (path: string | null) => void;
  onGridKeyDown: (e: ReactKeyboardEvent) => void;
}

// 카드가 한 줄에 몇 장인가 — 위·아래 방향키의 걸음(공유 탭 컷 카드 격자와 같은 셈).
function columnsOf(grid: HTMLElement): number {
  const cards = grid.querySelectorAll<HTMLElement>(":scope > [data-folder-path], :scope > [data-file-path]");
  let count = 0;
  for (const card of cards) {
    if (card.offsetTop !== cards[0].offsetTop) break;
    count += 1;
  }
  return Math.max(1, count);
}

export function AssetFolderGrid(props: AssetFolderGridProps) {
  const { project, groups, directFiles, scale, fit, layout, lastViewedPath, scrollRef, onScroll, onEnter, onOpenTab, onPreview } = props;
  const t = useT();
  const [selected, setSelected] = useState<string | null>(null);
  // 키보드(Jay 10-22 — 워크스페이스·공유처럼): 방향키 = 옆·위아래 카드를 고르고 초점도 옮긴다 · Enter = 고른 폴더로 들어가기/파일 크게 보기 ·
  //  Esc = 고른 것 풀기. 초점이 BODY·툴바에 있어도 받는다(useLooseKeys). 카드 안 단추에 초점이 있으면 Enter·Space 는 그 단추의 키다.
  const items = [...groups.map(({ folder }) => ({ path: folder.path, file: null as AssetNode | null })),
    ...directFiles.map((file) => ({ path: file.path, file }))];
  const onGridKey = (e: KeyboardEvent) => {
    if (backgroundKeysBlocked() || isTypingTarget(e.target) || e.isComposing || !items.length) return;
    const grid = scrollRef.current;
    if (!grid) return;
    const target = e.target as HTMLElement | null;
    const onControl = !!target?.closest?.("button, tr[tabindex]") && grid.contains(target);
    // 출발 카드 = 초점이 놓인 카드·줄(Tab 으로 옮겼을 수 있다), 없으면 고른 것(Codex 검토 3 K2 — 공유 탭 컷 카드와 같은 순서)
    const focusedCard = (document.activeElement as HTMLElement | null)?.closest?.<HTMLElement>("[data-folder-path], [data-file-path]");
    const focusedPath = focusedCard && grid.contains(focusedCard)
      ? focusedCard.getAttribute("data-folder-path") ?? focusedCard.getAttribute("data-file-path") : null;
    const at = items.findIndex((item) => item.path === (focusedPath ?? selected));
    if (e.key.startsWith("Arrow")) {
      if (e.altKey) return; // Alt+←/→ 는 브라우저의 뒤로/앞으로
      e.preventDefault();
      const rows = layout !== "grid";
      const step = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1
        : (e.key === "ArrowUp" ? -1 : 1) * (rows ? 1 : columnsOf(grid));
      const next = at < 0 ? 0 : Math.min(items.length - 1, Math.max(0, at + step));
      const path = items[next].path;
      setSelected(path);
      const attr = items[next].file ? "data-file-path" : "data-folder-path";
      const card = [...grid.querySelectorAll<HTMLElement>(`[${attr}]`)].find((el) => el.getAttribute(attr) === path);
      const focusable = card?.matches("tr") ? card : card?.querySelector<HTMLElement>(".ep-cover");
      focusable?.focus({ preventScroll: true });
      card?.scrollIntoView?.({ block: "nearest" });
    } else if (e.key === "Enter") {
      if (onControl || e.repeat || at < 0) return; // 초점 놓인 카드 단추·줄은 제 Enter 로 연다
      e.preventDefault();
      const item = items[at];
      if (item.file) onPreview(item.file);
      else onEnter(item.path);
    } else if (e.key === "Escape") {
      if (isKeyHandled(e) || selected === null) return;
      markKeyHandled(e);
      setSelected(null);
    }
  };
  useLooseKeys(scrollRef, onGridKey, (e) => e.key !== "Backspace"); // Backspace 는 어셋 창의 '상위 폴더로' 처리 몫(AssetsView)
  const onGridKeyDown = (e: ReactKeyboardEvent) => onGridKey(e.nativeEvent);
  if (layout === "table") return <AssetFolderTable {...props} selected={selected} setSelected={setSelected} onGridKeyDown={onGridKeyDown} />;
  const thumb = (file: AssetNode, size: number) => <MediaThumbnail
    thumb={file.type === "audio" ? null : api.assetThumbUrl(project, file.path, size, file.version)}
    isVideo={false} alt={file.name}
    fallback={<span className="assets-folder-placeholder">{file.type === "audio" ? t("오디오") : <FolderIcon />}</span>}
  />;
  return <div ref={scrollRef} onScroll={onScroll} className={"assets-folder-grid" + (layout === "list" ? " list" : "")}
    onClick={(event) => { if (event.target === event.currentTarget) setSelected(null); }}
    onKeyDown={onGridKeyDown}
    style={{ "--ep-scale": scale, gridTemplateColumns: layout === "list" ? "1fr" : `repeat(auto-fill, minmax(min(100%, ${Math.round(EPISODE_CARD_WIDTH * scale)}px), 1fr))` } as CSSProperties}>
    {groups.map(({ folder, files, category, folderCount, imageCount, videoCount, audioCount, children }) => {
      const summary = [folderCount ? `${t("폴더")} ${folderCount}` : "", `${files.length}${t("건")}`,
        imageCount ? `${t("이미지")} ${imageCount}` : "", videoCount ? `${t("영상")} ${videoCount}` : "",
        audioCount ? `${t("오디오")} ${audioCount}` : ""].filter(Boolean).join(" · ");
      const more = Math.max(0, (children.length || files.length) - STRIP_SHOWN.grid);
      return <article key={folder.path}
      className={"cut-card ep-card ep-grid assets-folder-card" + (selected === folder.path ? " sel" : "")} data-folder-path={folder.path}
      onMouseDown={(event) => { if (event.button === 1) event.preventDefault(); }}
      onAuxClick={(event) => {
        if (event.button !== 1 || (event.target instanceof Element && event.target.closest("[data-ep-action], [data-folder-action]"))) return;
        event.preventDefault(); onOpenTab(folder.path);
      }}>
      <button type="button" className={"ep-cover" + (fit === "contain" ? " contain" : "")}
        aria-label={`${category} ${folder.name} ${t("폴더 열기")}. ${summary}`} aria-pressed={selected === folder.path}
        title={`${folder.path} — ${t("더블클릭: 폴더 열기")} · ${t("미들클릭: 새 탭으로 열기")}`}
        onClick={() => setSelected(folder.path)}
        onDoubleClick={() => onEnter(folder.path)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.repeat && !event.nativeEvent.isComposing) {
            event.preventDefault(); onEnter(folder.path);
          }
        }}>
        <FolderCardCoverContent heading={category} name={category.toLowerCase() === folder.name.toLowerCase() ? "" : folder.name} summary={summary}>
          {files.length ? thumb(files[0], 512) : <span className="assets-folder-placeholder"><FolderIcon width={44} height={36} /></span>}
        </FolderCardCoverContent>
      </button>
      {layout === "list" && <span className="assets-folder-info"><strong>{folder.name}</strong><span>{summary}</span><AssetSourcePath project={project} path={folder.path} /></span>}
      {(children.length > 0 || files.length > 0) && <span className="ep-strip">
        {children.length ? children.slice(0, STRIP_SHOWN.grid).map((child) => <FolderCardPreview key={child.folder.path}
          name={child.folder.name} count={child.count} title={`${child.folder.path} · ${child.count}${t("건")}`}
          aria-label={`${child.folder.name} ${t("폴더 열기")}. ${child.count}${t("건")}`}
          onClick={() => onEnter(child.folder.path)}
          onMouseDown={(event) => { if (event.button === 1) event.preventDefault(); }}
          onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); onOpenTab(child.folder.path); } }}>
          {child.cover ? thumb(child.cover, 256) : <span className="assets-folder-placeholder"><FolderIcon /></span>}
        </FolderCardPreview>) : files.slice(0, STRIP_SHOWN.grid).map((file) => <FolderCardPreview key={file.path} title={file.name}
          aria-label={`${file.name} ${t("미리보기")}`} onClick={() => onPreview(file)}>{thumb(file, 256)}
          {lastViewedPath === file.path && <LastViewedBadge />}
        </FolderCardPreview>)}
        {more > 0 && <FolderCardPreview className="more" title={t("폴더 열기")}
          onClick={() => onEnter(folder.path)}>+{more}</FolderCardPreview>}
      </span>}
    </article>;
    })}
    {directFiles.map((file) => <article key={file.path} className={"cut-card ep-card ep-grid assets-folder-card" + (selected === file.path ? " sel" : "")} data-file-path={file.path}>
      <button type="button" className={"ep-cover" + (fit === "contain" ? " contain" : "")}
        aria-label={`${file.name} ${t("미리보기")}`} title={file.name} onClick={() => { setSelected(file.path); onPreview(file); }}>
        {thumb(file, 512)}
        {lastViewedPath === file.path && <LastViewedBadge />}
        <span className="ep-cap"><b>{file.name}</b></span>
      </button>
      {layout === "list" && <span className="assets-folder-info"><strong>{file.name}</strong><AssetSourcePath project={project} path={file.path} /></span>}
    </article>)}
    {groups.length === 0 && directFiles.length === 0 && <div className="assets-empty">{t("이 폴더에 미디어가 없습니다.")}</div>}
  </div>;
}
