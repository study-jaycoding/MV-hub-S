import { memo, useState, type DragEvent, type MouseEvent } from "react";
import { DRAG_TYPES } from "../../../lib/dragTypes";
import { parseSceneFolderDrag, parseSceneSetTags } from "../../../lib/sceneSet";
import type { SceneCard, SceneSetFolder } from "../../../lib/scenes";
import { useDragEndReset } from "../../../lib/useDragEndReset";

// 모양 = INPUT·OUTPUT 처럼 맨 위 자기 색 막대 + 물든 몸통, 값은 알약(Jay 2026-10-30 안 B).
// memo — 받은 값이 그대로면 다시 그리지 않는다(보드는 카드를 끄는 걸음마다 통째로 다시 그려진다 — ReferenceCard 의 주석 참고).
export const SetCard = memo(function SetCard({
  card,
  setFolder,
  setTagsText,
  flushPending,
  requestFit,
  onOutPortDown,
  onResizeDown,
}: {
  card: SceneCard;
  setFolder: (cardId: string, folder?: SceneSetFolder) => void;
  setTagsText: (cardId: string, tagsText: string) => void;
  flushPending: () => void;
  requestFit: (cardId: string) => void; // 태그를 다 치면 알약이 모두 보이게 카드를 늘린다(SceneBoard — 모델 노드와 같은 길)
  onOutPortDown: (e: MouseEvent, cardId: string) => void;
  onResizeDown: (e: MouseEvent, cardId: string) => void;
}) {
  const [dragOver, setDragOver] = useState(false);
  const [editingTags, setEditingTags] = useState(false);
  useDragEndReset(dragOver, () => setDragOver(false)); // 이 칸 위에서 끌기를 취소하면 dragleave 가 오지 않는다
  const folder = card.setCfg?.folder;
  const tagsText = card.setCfg?.tagsText || "";
  // 알약 = 생성 카드로 실제 넘어가는 태그 그대로(쉼표·줄 나눔, 앞 # 떼기, 중복 제거 — lib/sceneSet). 저장 값은 친 글 그대로다.
  const tags = editingTags ? [] : parseSceneSetTags(tagsText);
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
  const endTagEdit = () => {
    flushPending();
    setEditingTags(false);
    requestFit(card.id);
  };

  return (
    <>
      <div className="scene-card-inner scene-setnode">
        <div className="scene-card-hd setbar">SET</div>
        <div className="scene-setnode-body">
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
              <div className="scene-setnode-pill" title={`${folder.projectName || folder.projectId} / ${folder.path}`}>
                <span className="scene-setnode-icon">📁</span>
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
              <div className="scene-setnode-pill ph">
                <span className="scene-setnode-icon">📁</span>
                <span>폴더 끌어 놓기</span>
              </div>
            )}
          </div>
          <div className="scene-setnode-tags">
            <span className="scene-setnode-label">태그</span>
            {editingTags ? (
              <input
                className="scene-setnode-pill edit"
                value={tagsText}
                placeholder="#태그1, #태그2"
                spellCheck={false}
                autoFocus
                onMouseDown={(e) => e.stopPropagation()}
                onChange={(e) => setTagsText(card.id, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
                onBlur={endTagEdit}
              />
            ) : (
              <div
                className="scene-setnode-tagview"
                role="button"
                tabIndex={0}
                title={"태그\n누르면 고친다 · 쉼표로 나눈다"}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => setEditingTags(true)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") setEditingTags(true);
                }}
              >
                {tags.length ? (
                  tags.map((tag) => (
                    <span key={tag} className="scene-setnode-tag">
                      <i>#</i>
                      {tag}
                    </span>
                  ))
                ) : (
                  <span className="scene-setnode-pill ph">
                    <span className="scene-setnode-icon">#</span>
                    <span>태그1, 태그2</span>
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
      <span
        className="scene-port out lane-set"
        onMouseDown={(e) => onOutPortDown(e, card.id)}
        title={"세트 출력\n드래그 = 생성 카드 세트 입력(폴더·태그)에 연결"}
      />
      <span
        className="scene-resize"
        onMouseDown={(e) => onResizeDown(e, card.id)}
        title="드래그 = 크기 조절"
      />
    </>
  );
});
