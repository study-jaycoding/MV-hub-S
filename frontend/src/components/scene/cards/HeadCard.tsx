// Head(제목) 카드 본문 — SceneBoard 렌더 분할(R2). 셸은 부모 소유, Fragment 만 반환(규칙은 OutputCard 참고).
import type React from "react";
import type { SceneCard } from "../../../lib/scenes";
import { GROUP_COLORS } from "../sceneColors";

export function HeadCard({
  card,
  sel,
  editing,
  colorPopId,
  setEditTextId,
  setColorPopId,
  setNodeText,
  setNodeFontSize,
  setNodeColor,
  flushPending,
}: {
  card: SceneCard;
  sel: boolean;
  editing: boolean;
  colorPopId: string | null;
  setEditTextId: (id: string | null) => void;
  setColorPopId: React.Dispatch<React.SetStateAction<string | null>>;
  setNodeText: (cardId: string, text: string) => void;
  setNodeFontSize: (cardId: string, fontSize: number) => void;
  setNodeColor: (cardId: string, color: string) => void;
  flushPending: () => void;
}) {
  // Head(제목) — 포트 없는 주석 글씨. 박스는 글씨에 맞춰 자동 크기. 색·글씨크기는 선택 시 컨트롤로.
  const fs = card.fontSize ?? 32;
  const col = card.color || "#e8c341";
  return (
    <>
      {editing ? (
        // 편집 textarea — 멀티라인(Shift+Enter=줄바꿈, Enter=완료). 박스는 글씨에 맞춰 자동
        //  크기(field-sizing:content). rows 는 미지원 브라우저 폴백용 초기 줄 수.
        <textarea
          className="scene-headnode-edit"
          value={card.text || ""}
          placeholder="제목"
          autoFocus
          rows={Math.max(1, (card.text || "제목").split("\n").length)}
          wrap="off"
          style={{ fontSize: fs, color: col }}
          onMouseDown={(e) => e.stopPropagation()}
          onBlur={() => { setEditTextId(null); flushPending(); }} // 편집 끝나면 밀린 저장 확정
          onChange={(e) => setNodeText(card.id, e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") {
              setEditTextId(null);
              return;
            }
            // Enter=편집 완료, Shift+Enter=줄바꿈(기본 동작 허용).
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              setEditTextId(null);
            }
          }}
        />
      ) : (
        <div
          className="scene-headnode-text"
          style={{ fontSize: fs, color: col }}
          onDoubleClick={(e) => {
            e.stopPropagation();
            setEditTextId(card.id);
          }}
        >
          {card.text || "제목"}
        </div>
      )}
      {sel && !editing && (
        <div className="scene-headnode-ctrls" onMouseDown={(e) => e.stopPropagation()}>
          {/* 가운데 — 글씨 크기 스테퍼 */}
          <div className="scene-headnode-fs" title="글씨 크기">
            <button onClick={() => setNodeFontSize(card.id, fs - 4)}>−</button>
            <span>{fs}</span>
            <button onClick={() => setNodeFontSize(card.id, fs + 4)}>＋</button>
          </div>
          {/* 맨 우측 — 글씨 색(그룹처럼 스와치 팔레트 팝업) */}
          <div className="scene-headnode-colorwrap">
            <button
              className="scene-group-color"
              title="글씨 색"
              style={{ background: col }}
              onClick={(e) => {
                e.stopPropagation();
                setColorPopId((p) => (p === card.id ? null : card.id));
              }}
            />
            {colorPopId === card.id && (
              <div className="scene-group-colorpop">
                {GROUP_COLORS.map((c) => (
                  <button
                    key={c}
                    className={"scene-group-swatch" + (col === c ? " on" : "")}
                    style={{ background: c }}
                    title={c}
                    onClick={(e) => {
                      e.stopPropagation();
                      setNodeColor(card.id, c);
                      setColorPopId(null);
                    }}
                  />
                ))}
                <label className="scene-group-swatch custom" title="커스텀 색">
                  <input
                    type="color"
                    value={col}
                    onChange={(e) => setNodeColor(card.id, e.target.value)}
                  />
                </label>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
