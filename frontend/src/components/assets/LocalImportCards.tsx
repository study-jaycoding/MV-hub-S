import { useCallback, useEffect, useRef } from "react";
import { api } from "../../api";
import { DRAG_TYPES } from "../../lib/dragTypes";
import { downloadOne } from "../../lib/download";
import { loadString, removeStorage, saveString } from "../../lib/storage";
import { STORAGE_KEYS } from "../../lib/storageKeys";
import type { AssetNode, PreviewTarget } from "../../types";
import { MediaThumbnail } from "../MediaThumbnail";
import { assetPreviewTarget } from "./assetsViewModel";
import type { LocalAssetImport } from "./useAssetDropImport";
import { captureSubmissionScope, OperationContextChangedError } from "../../app/operationContext";
import { flashMsg } from "../../lib/flash";

export function LocalImportCards({ items, onPreview }: { items: LocalAssetImport[]; onPreview: (target: PreviewTarget) => void }) {
  const dragPayload = useRef<string | null>(null);
  const dragId = useRef<string | null>(null);
  const clearDrag = useCallback(() => {
    try {
      if (dragPayload.current && loadString(STORAGE_KEYS.assetsDrag) === dragPayload.current) removeStorage(STORAGE_KEYS.assetsDrag);
    } catch { /* storage unavailable */ }
    dragPayload.current = null;
    dragId.current = null;
  }, []);
  useEffect(() => clearDrag, [clearDrag]);
  useEffect(() => {
    if (dragId.current && !items.some(item => item.id === dragId.current && item.current())) clearDrag();
  }, [items, clearDrag]);
  if (!items.length) return null;
  const nodes: AssetNode[] = items.map(item => ({ path: item.localPath, name: item.name, type: item.type }));
  return <section className="asset-local-imports" aria-label="로컬 보관 중인 파일"
    onMouseDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}
    onDragStart={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
    <header>로컬 사용 가능 · 폴더 보관 대기 <span>{items.length}건</span></header>
    <div className="asset-local-cards">{items.map((item, index) => {
      const url = api.assetFileUrl("imports", item.localPath);
      const preview = () => {
        if (!item.current()) return;
        const target = assetPreviewTarget("imports", nodes, nodes[index]);
        if (target) onPreview(target);
      };
      return <article key={item.id} className="asset-local-card">
        <button type="button" className="asset-local-thumb" title={`${item.name} 미리보기`} onClick={preview}>
          <MediaThumbnail thumb={item.type === "audio" ? null : api.assetThumbUrl("imports", item.localPath, 256)}
            isVideo={item.type === "video"} src={url} alt={item.name} retrySrcOnThumbError fallback={<span>{item.type === "audio" ? "오디오" : item.name}</span>} />
        </button>
        <strong title={item.name}>{item.name}</strong>
        <span className={item.state === "registration_failed" ? "asset-local-error" : ""}>
          {item.state === "registration_failed" ? "로컬 사용 가능 · 보관 예약 실패" : item.state === "ready" ? "폴더 목록 반영 확인 중" : "로컬 사용 가능 · 폴더 보관 대기"}
        </span>
        <div className="asset-local-actions">
          <span draggable className="asset-local-ref" title="프롬프트 또는 캔버스로 끌어 참조로 사용"
            aria-label="마우스로 프롬프트 또는 캔버스에 끌어 참조로 사용" onDragEnd={clearDrag}
            onDragStart={event => {
              event.stopPropagation();
              if (!item.current()) { event.preventDefault(); return; }
              clearDrag();
              const payload = JSON.stringify([{ project: "imports", path: item.localPath, name: item.name,
                type: item.type, file_path: `asset:imports|${item.localPath}`, asset_content_id: item.assetContentId }]);
              event.dataTransfer.effectAllowed = "copy";
              event.dataTransfer.setData(DRAG_TYPES.asset, payload);
              try { saveString(STORAGE_KEYS.assetsDrag, payload); dragPayload.current = payload; dragId.current = item.id; } catch { /* custom drag payload remains available */ }
            }}>↗ 참조로 끌기</span>
          <button type="button" onClick={() => {
            if (!item.current()) return;
            const scope = captureSubmissionScope({ scope: "unknown", id: null, name: null });
            const assertCurrent = () => {
              if (!item.current() || !scope.isCurrent?.()) throw new OperationContextChangedError();
            };
            void downloadOne(url, item.name, undefined, false, { context: scope.operation!, assertCurrent }).catch(error => {
              try { assertCurrent(); } catch { return; }
              flashMsg(`다운로드 실패: ${error instanceof Error ? error.message : String(error)}`);
            });
          }}>⤓ 다운로드</button>
        </div>
      </article>;
    })}</div>
  </section>;
}
