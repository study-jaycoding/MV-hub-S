import { useRef, useState } from "react";
import type { DragEvent } from "react";
import { api } from "../../api";
import { dataTransferHasFiles } from "../../lib/media";
import { DRAG_TYPES } from "../../lib/dragTypes";

export function useAssetDropImport({
  dir,
  project,
  onImported,
}: {
  dir: string;
  project: string;
  // 업로드 후 새로고침 — 가드·캐시가 있는 refreshProjectData 로 위임(전환 중이면 화면 대신 캐시만 갱신).
  onImported: (project: string) => void | Promise<void>;
}) {
  const [dropActive, setDropActive] = useState(false);
  const [importing, setImporting] = useState(false);
  const dropDepth = useRef(0);

  // 외부 파일 가져오기 대상만 감지한다. 내부 에셋 드래그는 원본을 '진짜 File' 로 실어(대화창 첨부용)
  //  dataTransfer 에 "Files" 가 잡히지만, 같은 폴더로 되-업로드(중복 생성)하면 안 되므로 제외한다.
  const hasFiles = (event: DragEvent) =>
    !event.dataTransfer.types.includes(DRAG_TYPES.asset) &&
    dataTransferHasFiles(event.dataTransfer);

  const importFiles = async (incoming: File[]) => {
    if (!project || !incoming.length) return;
    setImporting(true);
    try {
      const result = await api.uploadAssets(project, dir, incoming);
      await onImported(project); // 트리·메타 새로고침을 가드된 경로로 위임(직접 setter 로 stale 반영/캐시 오염 방지)
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
