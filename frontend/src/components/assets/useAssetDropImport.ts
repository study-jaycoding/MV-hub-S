import { useRef, useState } from "react";
import type { DragEvent } from "react";
import { api } from "../../api";
import { dataTransferHasFiles, filesFromDataTransfer } from "../../lib/media";
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
  // 돌고 있는 반입의 수 — 참/거짓으로 두면 겹친 반입 가운데 먼저 끝난 쪽이 '가져오는 중' 표시를 지운다.
  const [importing, setImporting] = useState(0);
  // 올리는 중인 파일(자리·이름·크기·수정 시각) — 올라가는 동안 같은 파일을 다시 놓으면 서버가 이름을 _2 로 피해 사본이 생긴다(조작 규칙 39).
  //  내용이 아니라 파일 정보로 가린다. 다 올라간 뒤에 다시 놓는 것은 전처럼 받는다.
  const uploading = useRef(new Set<string>());
  const dropDepth = useRef(0);

  // 외부 파일 가져오기 대상만 감지한다. 내부 에셋 드래그는 원본을 '진짜 File' 로 실어(대화창 첨부용)
  //  dataTransfer 에 "Files" 가 잡히지만, 같은 폴더로 되-업로드(중복 생성)하면 안 되므로 제외한다.
  const hasFiles = (event: DragEvent) =>
    !event.dataTransfer.types.includes(DRAG_TYPES.asset) &&
    dataTransferHasFiles(event.dataTransfer);

  const importFiles = async (incoming: File[]) => {
    if (!project || !incoming.length) return;
    const keyOf = (file: File) => JSON.stringify([project, dir, file.name, file.size, file.lastModified]);
    const fresh: File[] = [];
    const keys: string[] = [];
    for (const file of incoming) { // 첫 await 전에 가리고 적는다 — 같은 묶음 안의 겹친 파일도 여기서 걸린다
      const key = keyOf(file);
      if (uploading.current.has(key)) continue;
      uploading.current.add(key);
      keys.push(key);
      fresh.push(file);
    }
    if (!fresh.length) {
      alert("이미 가져오는 중인 파일입니다.");
      return;
    }
    setImporting((count) => count + 1);
    try {
      const result = await api.uploadAssets(project, dir, fresh);
      await onImported(project); // 트리·메타 새로고침을 가드된 경로로 위임(직접 setter 로 stale 반영/캐시 오염 방지)
      if (result.skipped.length) {
        alert(
          `${result.saved.length}개 추가됨.\n미디어가 아니어서 제외: ${result.skipped.join(", ")}`,
        );
      }
    } catch (error) {
      alert(`가져오기 실패: ${error}`);
    } finally {
      for (const key of keys) uploading.current.delete(key);
      setImporting((count) => count - 1);
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
    const incoming = filesFromDataTransfer(event.dataTransfer);
    if (incoming.length) void importFiles(incoming);
  };

  return {
    dropActive,
    importing: importing > 0,
    onZoneDragEnter,
    onZoneDragLeave,
    onZoneDragOver,
    onZoneDrop,
  };
}
