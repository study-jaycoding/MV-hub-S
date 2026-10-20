import { api } from "../../api";
import { useT } from "../../lib/i18n";
import { reportSourceLocationError } from "../../lib/sourceLocationFeedback";

export function AssetSourcePath({ project, path }: { project: string; path: string }) {
  const t = useT();
  return <button type="button" className="assets-source-path" data-folder-action
    title={t("원본 위치 열기 (탐색기)")}
    onClick={(event) => { event.stopPropagation(); api.revealAsset(project, path).catch(reportSourceLocationError); }}
    onKeyDown={(event) => {
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        if (!event.repeat && !event.nativeEvent.isComposing) api.revealAsset(project, path).catch(reportSourceLocationError);
      }
    }}
    onDoubleClick={(event) => event.stopPropagation()}
    onMouseDown={(event) => { event.stopPropagation(); if (event.button === 1) event.preventDefault(); }}
    onAuxClick={(event) => { event.stopPropagation(); if (event.button === 1) event.preventDefault(); }}>{path}</button>;
}
