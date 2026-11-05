// 도구 캡슐 — 그림·영상 바로 밑 가운데 한 줄(힉스필드 편집기처럼, Jay 2026-10-28 시안 4차).
// 수정 창에서 그대로 떼어 냈고 코멘트 그림도 같은 캡슐을 쓴다. 색은 색 단추를 눌러 여는 작은 창에.
import { Fragment } from "react";
import { COLORS, textPx, type ShapeKind } from "./strokes";
import type { DrawingInput } from "./useDrawingInput";

// 도구 캡슐의 선 아이콘(18px)
const TOOL_ICON = {
  viewBox: "0 0 24 24", width: 18, height: 18, fill: "none", stroke: "currentColor", strokeWidth: 2,
  strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true,
};
export const TOOL_ICONS = {
  pen: <svg {...TOOL_ICON}><path d="M4 20h4L18.5 9.5a2.83 2.83 0 1 0-4-4L4 16v4" /><path d="M13.5 6.5l4 4" /></svg>,
  erase: <svg {...TOOL_ICON}><path d="M19 20h-10.5l-4.21-4.3a1 1 0 0 1 0-1.41l10-10a1 1 0 0 1 1.41 0l5 5a1 1 0 0 1 0 1.41l-9.2 9.3" /><path d="M18 13.3l-6.3-6.3" /></svg>,
  line: <svg {...TOOL_ICON}><path d="M5 19 19 5" /></svg>,
  arrow: <svg {...TOOL_ICON}><path d="M5 19 19 5" /><path d="M9 5h10v10" /></svg>,
  rect: <svg {...TOOL_ICON}><rect x="4" y="5" width="16" height="14" rx="2" /></svg>,
  ellipse: <svg {...TOOL_ICON}><ellipse cx="12" cy="12" rx="8.5" ry="7" /></svg>,
  undo: <svg {...TOOL_ICON}><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></svg>,
  redo: <svg {...TOOL_ICON}><path d="m15 14 5-5-5-5" /><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" /></svg>,
  clear: <svg {...TOOL_ICON}><path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3" /></svg>,
  text: <svg {...TOOL_ICON}><path d="M5 7V5h14v2" /><path d="M12 5v14" /><path d="M9 19h6" /></svg>,
};
// [도구, 이름, 단축키] — 펜·지우개 다음에 도형 넷(옛 Shapes 하위 단추를 캡슐로 꺼냄)과 글자. R 은 마지막 도형으로 돌아간다.
const DRAW_TOOLS: ["pen" | "erase" | "text" | ShapeKind, string, string][] = [
  ["pen", "펜", "D"], ["erase", "지우개", "E"],
  ["line", "선", ""], ["arrow", "화살표", ""], ["rect", "사각형", ""], ["ellipse", "원", ""], ["text", "글자", "T"],
];

export function DrawDock({ draw }: { draw: DrawingInput }) {
  const {
    tool, setTool, shapeKind, setShapeKind, color, setColor, brushSize, setBrushSize, sizeText, setSizeText, applySizeText,
    colorOpen, setColorOpen, dockRef, items, redo, undoStroke, redoStroke, clearStrokes,
  } = draw;
  return (
    <div className="pe-toolrow">
      <div className="pe-dock" ref={dockRef}>
        {DRAW_TOOLS.map(([key, label, keyHint]) => {
          const single = key === "pen" || key === "erase" || key === "text";
          const on = single ? tool === key : tool === "shape" && shapeKind === key;
          return (
            <Fragment key={key}>
              {key === "line" && <span className="pe-div" />}
              <button type="button" className={on ? "on" : ""} title={`${label}${keyHint ? ` (${keyHint})` : ""}`} aria-label={label}
                aria-pressed={on}
                onClick={() => {
                  if (key === "pen" || key === "erase" || key === "text") setTool(key);
                  else { setTool("shape"); setShapeKind(key); }
                }}>
                {TOOL_ICONS[key]}
              </button>
            </Fragment>
          );
        })}
        <span className="pe-div" />
        <button type="button" className={colorOpen ? "on-soft" : ""} title="색" aria-label="색"
          aria-expanded={colorOpen} onClick={() => setColorOpen(!colorOpen)}>
          <span className="pe-dot" style={{ background: color }} />
        </button>
        {/* 굵기 — 캡슐에 바로(Jay 10-28: 색 창 안에 있어 못 찾음). 펜·지우개·도형 굵기와 글자 크기를 함께 정한다 */}
        <div className="pe-size" title="굵기·글자 크기 ([ ] 로도)">
          <span className="pe-size-dotbox">
            <span className="pe-size-dot" style={{ width: Math.min(16, Math.max(3, brushSize / 7)), height: Math.min(16, Math.max(3, brushSize / 7)), background: color }} />
          </span>
          <input type="range" aria-label="굵기" min={4} max={120} value={brushSize} onChange={(e) => setBrushSize(Number(e.target.value))} />
          {/* 숫자는 고정 폭 칸 — 1~3자리여도 캡슐 크기가 그대로이고, 직접 칠 수 있다(Jay 10-28) */}
          <input className="pe-size-val" type="text" inputMode="numeric" aria-label="굵기 숫자" maxLength={3}
            value={sizeText ?? String(brushSize)}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setSizeText(e.target.value.replace(/\D/g, ""))}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); applySizeText(); e.currentTarget.blur(); }
            }}
            onBlur={applySizeText} />
        </div>
        <span className="pe-div" />
        <button type="button" title="되돌리기 (Ctrl+Z)" aria-label="되돌리기" disabled={!items.length} onClick={undoStroke}>{TOOL_ICONS.undo}</button>
        <button type="button" title="다시 (Ctrl+Shift+Z)" aria-label="다시" disabled={!redo.length} onClick={redoStroke}>{TOOL_ICONS.redo}</button>
        <button type="button" title="전체 지우기" aria-label="전체 지우기" disabled={!items.length} onClick={clearStrokes}>{TOOL_ICONS.clear}</button>
        {colorOpen && (
          <div className="pe-pop">
            <div className="pe-pop-row">
              {COLORS.map((c) => (
                <button key={c} type="button" className={"pe-swatch" + (color === c ? " sel" : "")} style={{ background: c }}
                  title={c} aria-label={`색 ${c}`} aria-pressed={color === c} onClick={() => setColor(c)} />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** 무대 위 글자 입력칸 — 누른 자리에 뜬다. Enter·바깥 누름 = 확정, Esc = 이 글자만 취소(창이 처리). */
export function DrawTextInput({ draw }: { draw: DrawingInput }) {
  const { textDraft, setTextDraft, color, brushSize, commitText } = draw;
  if (!textDraft) return null;
  return (
    <input
      className="pe-text-input"
      aria-label="글자 입력"
      // 초점은 화면을 움직이지 않고 — autoFocus 는 무대 상자를 옆으로 굴려 그림이 밀렸다(10-28 실측)
      ref={(el) => { if (el && document.activeElement !== el) el.focus({ preventScroll: true }); }}
      value={textDraft.text}
      // 폭 = 글자 수 × 1em(한글 한 자 폭) — size 속성은 영문 평균 폭이라 한글 앞글자가 칸 안에서 밀려 가려졌다(10-28 실측)
      style={{ left: textDraft.left, top: textDraft.top, color, fontSize: `${textPx(brushSize) * textDraft.scale}px`,
        width: `${Math.max(3, textDraft.text.length + 1)}em` }}
      onChange={(e) => setTextDraft({ ...textDraft, text: e.target.value })}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing || e.keyCode === 229) return; // 한글 조합 중 Enter 는 확정이 아니다
        if (e.key === "Enter") {
          e.preventDefault();
          commitText();
        }
      }}
      onBlur={commitText}
    />
  );
}
