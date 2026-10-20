import { useState, type CSSProperties } from "react";
import { api } from "../../api";
import { useT } from "../../lib/i18n";
import type { AssetNode } from "../../types";
import { FolderIcon } from "../FolderIcon";
import { MediaThumbnail } from "../MediaThumbnail";
import type { AssetFolderGridProps } from "./AssetFolderGrid";
import { AssetSourcePath } from "./AssetSourcePath";

type Props = Omit<AssetFolderGridProps, "layout">;

export function AssetFolderTable({ project, groups, directFiles, scale, fit, lastViewedPath, scrollRef, onScroll, onEnter, onOpenTab, onPreview }: Props) {
  const t = useT();
  const [selected, setSelected] = useState<string | null>(null);
  const preview = (file?: AssetNode) => file ? <button type="button"
    className={"assets-folder-table-preview" + (fit === "contain" ? " contain" : "")}
    data-folder-preview data-folder-action aria-label={`${file.name} ${t("미리보기")}`} title={file.name}
    onClick={(event) => { event.stopPropagation(); onPreview(file); }}>
    <MediaThumbnail thumb={file.type === "audio" ? null : api.assetThumbUrl(project, file.path, 256, file.version)}
      isVideo={false} alt={file.name}
      fallback={<span className="assets-folder-placeholder">{file.type === "audio" ? t("오디오") : <FolderIcon />}</span>} />
    {lastViewedPath === file.path && <span className="asset-last-viewed">Last viewed</span>}
  </button> : <span className="assets-folder-placeholder"><FolderIcon /></span>;
  const isAction = (target: EventTarget) => target instanceof Element && !!target.closest("[data-folder-action]");
  return <div ref={scrollRef} onScroll={onScroll} className="assets-folder-grid table assets-folder-table"
    style={{ "--ep-scale": scale } as CSSProperties}
    onClick={(event) => { if (event.target === event.currentTarget) setSelected(null); }}>
    {groups.length || directFiles.length ? <table>
      <thead><tr>
        <th scope="col">{t("미리보기")}</th><th scope="col">{t("이름")}</th>
        <th scope="col">{t("폴더")}</th><th scope="col">{t("파일")}</th>
        <th scope="col">{t("이미지")}</th><th scope="col">{t("영상")}</th><th scope="col">{t("오디오")}</th>
      </tr></thead>
      <tbody>
        {groups.map(({ folder, files, folderCount, imageCount, videoCount, audioCount }) => <tr key={folder.path}
          data-folder-path={folder.path} tabIndex={0} aria-selected={selected === folder.path}
          className={selected === folder.path ? "sel" : undefined}
          title={`${folder.path} — ${t("더블클릭: 폴더 열기")} · ${t("미들클릭: 새 탭으로 열기")}`}
          onClick={() => setSelected(folder.path)}
          onDoubleClick={(event) => { if (!isAction(event.target)) onEnter(folder.path); }}
          onMouseDown={(event) => { if (event.button === 1) event.preventDefault(); }}
          onAuxClick={(event) => {
            if (event.button === 1 && !isAction(event.target)) { event.preventDefault(); onOpenTab(folder.path); }
          }}
          onKeyDown={(event) => {
            if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ") && !event.repeat && !event.nativeEvent.isComposing) {
              event.preventDefault(); onEnter(folder.path);
            }
          }}>
          <td>{preview(files[0])}</td>
          <th scope="row"><FolderIcon /><span>{folder.name}</span><AssetSourcePath project={project} path={folder.path} /></th>
          <td>{folderCount}</td><td>{files.length}</td>
          <td>{imageCount}</td><td>{videoCount}</td><td>{audioCount}</td>
        </tr>)}
        {directFiles.map((file) => <tr key={file.path} data-file-path={file.path} tabIndex={0}
          onClick={() => onPreview(file)}
          onKeyDown={(event) => {
            if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ") && !event.repeat && !event.nativeEvent.isComposing) {
              event.preventDefault(); onPreview(file);
            }
          }}>
          <td>{preview(file)}</td>
          <th scope="row"><span>{file.name}</span><AssetSourcePath project={project} path={file.path} /></th>
          <td>0</td><td>1</td>
          <td>{file.type === "image" ? 1 : 0}</td><td>{file.type === "video" ? 1 : 0}</td><td>{file.type === "audio" ? 1 : 0}</td>
        </tr>)}
      </tbody>
    </table> : <div className="assets-empty">{t("이 폴더에 미디어가 없습니다.")}</div>}
  </div>;
}
