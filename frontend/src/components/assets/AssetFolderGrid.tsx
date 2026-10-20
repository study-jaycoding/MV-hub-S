import { useState, type CSSProperties, type Ref, type UIEventHandler } from "react";
import { api } from "../../api";
import { useT } from "../../lib/i18n";
import { EPISODE_CARD_WIDTH, STRIP_SHOWN } from "../../lib/episodeBoard";
import type { AssetNode } from "../../types";
import { FolderIcon } from "../FolderIcon";
import { FolderCardCoverContent, FolderCardPreview } from "../FolderCardVisuals";
import { MediaThumbnail } from "../MediaThumbnail";
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
  scrollRef: Ref<HTMLDivElement>;
  onScroll: UIEventHandler<HTMLDivElement>;
  onEnter: (path: string) => void;
  onOpenTab: (path: string) => void;
  onPreview: (file: AssetNode) => void;
}

export function AssetFolderGrid(props: AssetFolderGridProps) {
  const { project, groups, directFiles, scale, fit, layout, lastViewedPath, scrollRef, onScroll, onEnter, onOpenTab, onPreview } = props;
  const t = useT();
  const [selected, setSelected] = useState<string | null>(null);
  if (layout === "table") return <AssetFolderTable {...props} />;
  const thumb = (file: AssetNode, size: number) => <MediaThumbnail
    thumb={file.type === "audio" ? null : api.assetThumbUrl(project, file.path, size, file.version)}
    isVideo={false} alt={file.name}
    fallback={<span className="assets-folder-placeholder">{file.type === "audio" ? t("오디오") : <FolderIcon />}</span>}
  />;
  return <div ref={scrollRef} onScroll={onScroll} className={"assets-folder-grid" + (layout === "list" ? " list" : "")}
    onClick={(event) => { if (event.target === event.currentTarget) setSelected(null); }}
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
          {lastViewedPath === file.path && <span className="asset-last-viewed">Last viewed</span>}
        </FolderCardPreview>)}
        {more > 0 && <FolderCardPreview className="more" title={t("폴더 열기")}
          onClick={() => onEnter(folder.path)}>+{more}</FolderCardPreview>}
      </span>}
    </article>;
    })}
    {directFiles.map((file) => <article key={file.path} className="cut-card ep-card ep-grid assets-folder-card" data-file-path={file.path}>
      <button type="button" className={"ep-cover" + (fit === "contain" ? " contain" : "")}
        aria-label={`${file.name} ${t("미리보기")}`} title={file.name} onClick={() => onPreview(file)}>
        {thumb(file, 512)}
        {lastViewedPath === file.path && <span className="asset-last-viewed">Last viewed</span>}
        <span className="ep-cap"><b>{file.name}</b></span>
      </button>
      {layout === "list" && <span className="assets-folder-info"><strong>{file.name}</strong><AssetSourcePath project={project} path={file.path} /></span>}
    </article>)}
    {groups.length === 0 && directFiles.length === 0 && <div className="assets-empty">{t("이 폴더에 미디어가 없습니다.")}</div>}
  </div>;
}
