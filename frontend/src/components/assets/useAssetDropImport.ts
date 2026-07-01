import { useRef, useState } from "react";
import type { DragEvent } from "react";
import { api } from "../../api";
import { dataTransferHasFiles } from "../../lib/media";
import type { AssetMeta, AssetNode } from "../../types";

export function useAssetDropImport({
  dir,
  project,
  onMetaLoaded,
  onTreeLoaded,
}: {
  dir: string;
  project: string;
  onMetaLoaded: (meta: Record<string, AssetMeta>) => void;
  onTreeLoaded: (tree: AssetNode[]) => void;
}) {
  const [dropActive, setDropActive] = useState(false);
  const [importing, setImporting] = useState(false);
  const dropDepth = useRef(0);

  const hasFiles = (event: DragEvent) => dataTransferHasFiles(event.dataTransfer);

  const importFiles = async (incoming: File[]) => {
    if (!project || !incoming.length) return;
    setImporting(true);
    try {
      const result = await api.uploadAssets(project, dir, incoming);
      const tree = await api.assetTree(project);
      onTreeLoaded(tree.children);
      const meta = await api.assetMeta(project);
      onMetaLoaded(meta);
      if (result.skipped.length) {
        alert(
          `${result.saved.length}개 추가됨.\n미디어가 아니어서 제외: ${result.skipped.join(", ")}`,
        );
      }
    } catch (error) {
      alert(`가져오기 실패: ${error}`);
    } finally {
      setImporting(false);
    }
  };

  const onZoneDragEnter = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dropDepth.current++;
    setDropActive(true);
  };

  const onZoneDragOver = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const onZoneDragLeave = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    dropDepth.current--;
    if (dropDepth.current <= 0) {
      dropDepth.current = 0;
      setDropActive(false);
    }
  };

  const onZoneDrop = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dropDepth.current = 0;
    setDropActive(false);
    const incoming = Array.from(event.dataTransfer.files);
    if (incoming.length) void importFiles(incoming);
  };

  return {
    dropActive,
    importing,
    onZoneDragEnter,
    onZoneDragLeave,
    onZoneDragOver,
    onZoneDrop,
  };
}
