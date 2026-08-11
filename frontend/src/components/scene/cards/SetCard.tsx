import { useState, type DragEvent, type MouseEvent } from "react";
import { DRAG_TYPES } from "../../../lib/dragTypes";
import { parseSceneFolderDrag } from "../../../lib/sceneSet";
import type { SceneCard, SceneSetFolder } from "../../../lib/scenes";

export function SetCard({
  card,
  setFolder,
  setTagsText,
  flushPending,
  onOutPortDown,
  onResizeDown,
}: {
  card: SceneCard;
  setFolder: (cardId: string, folder?: SceneSetFolder) => void;
  setTagsText: (cardId: string, tagsText: string) => void;
  flushPending: () => void;
  onOutPortDown: (e: MouseEvent, cardId: string) => void;
  onResizeDown: (e: MouseEvent, cardId: string) => void;
}) {
  const [dragOver, setDragOver] = useState(false);
  const folder = card.setCfg?.folder;
  const acceptFolder = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes(DRAG_TYPES.folder)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
    setDragOver(true);
  };
  const dropFolder = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const parsed = parseSceneFolderDrag(e.dataTransfer.getData(DRAG_TYPES.folder));
    if (parsed) setFolder(card.id, parsed);
  };

  return (
    <>
      <div className="scene-card-hd set scene-card-hd-float">SET</div>
      <div className="scene-card-inner scene-setnode">
        <div
          className={`scene-setnode-folder${dragOver ? " drag-over" : ""}`}
          onDragEnter={acceptFolder}
          onDragOver={acceptFolder}
          onDragLeave={(e) => {
            e.stopPropagation();
            setDragOver(false);
          }}
          onDrop={dropFolder}
        >
          <span className="scene-setnode-label">폴더</span>
          {folder ? (
            <div className="scene-setnode-folder-value" title={`${folder.projectName || folder.projectId} / ${folder.path}`}>
              <span className="scene-setnode-folder-icon">📁</span>
              <span className="scene-setnode-folder-text">
                {folder.projectName || folder.projectId} › {folder.path}
              </span>
              <button
                type="button"
                className="scene-setnode-clear"
                title="폴더 설정 지우기"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  setFolder(card.id, undefined);
                }}
              >
                ×
              </button>
            </div>
          ) : (
            <div className="scene-setnode-folder-empty">왼쪽 폴더를 끌어 놓으세요</div>
          )}
        </div>
        <label className="scene-setnode-tags">
          <span className="scene-setnode-label">태그</span>
          <textarea
            value={card.setCfg?.tagsText || ""}
            placeholder="태그1, 태그2"
            spellCheck={false}
            onMouseDown={(e) => e.stopPropagation()}
            onChange={(e) => setTagsText(card.id, e.target.value)}
            onBlur={flushPending}
          />
        </label>
      </div>
      <span
        className="scene-port out lane-text"
        onMouseDown={(e) => onOutPortDown(e, card.id)}
        title="드래그해 생성 카드 텍스트 입력에 연결"
      />
      <span
        className="scene-resize"
        onMouseDown={(e) => onResizeDown(e, card.id)}
        title="드래그해 크기 조절"
      />
    </>
  );
}
