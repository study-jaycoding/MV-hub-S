// 그리기 입력 — 수정 창(PartialEditModal)에서 그대로 떼어 낸 획·도구·색·굵기·글자 입력·포인터 처리.
// 코멘트 그림(CommentDrawModal)도 같은 도구를 쓴다(설계 §2). 동작은 수정 창의 것과 같다.
import { useEffect, useRef, useState } from "react";
import { useOutsideMouseDown } from "../../../lib/useOutsideMouseDown";
import { COLORS, DEFAULT_COLOR, drawItem, textPx, type DrawItem, type PenStroke, type ShapeItem, type ShapeKind } from "./strokes";

const LS_COLOR = "ch.partialEdit.color";
const LS_TOOL = "ch.partialEdit.tool";

export type DrawTool = "pen" | "erase" | "shape" | "text";

interface Options {
  /** 그리는 캔버스 크기(작업 px) — 없으면 아직 못 그린다 */
  src: { w: number; h: number } | null;
  /** 지금 그릴 수 있는가(수정 창의 draw 단계) */
  active: boolean;
  /** 획을 시작하기 직전(수정 창은 재생 중이면 그 자리에 멈춘다). false 를 돌려주면 이 누름은 그리지 않는다(코멘트 그림 12장 한도) */
  onStrokeStart?: () => boolean | void;
}

export function useDrawingInput({ src, active, onStrokeStart }: Options) {
  // ── 주석(펜·도형 → annot 캔버스, 표시 = 전송본) ──
  const [items, setItems] = useState<DrawItem[]>([]);
  // 되돌린 획 — 다시(Ctrl+Shift+Z·Ctrl+Y)가 꺼낸다. 새 획을 그리거나 전체 지우면 비운다.
  const [redo, setRedo] = useState<DrawItem[]>([]);
  const undoStroke = () => {
    if (!items.length) return;
    setRedo([...redo, items[items.length - 1]]);
    setItems(items.slice(0, -1));
  };
  const redoStroke = () => {
    if (!redo.length) return;
    setItems([...items, redo[redo.length - 1]]);
    setRedo(redo.slice(0, -1));
  };
  const clearStrokes = () => {
    setItems([]);
    setRedo([]);
  };
  // 도구·색은 마지막 사용값을 기억 — 프라이빗 모드 등 스토리지 차단 환경에서도 크래시 없이 기본값.
  const [tool, setTool] = useState<DrawTool>(() => {
    try {
      const saved = localStorage.getItem(LS_TOOL);
      if (saved === "pen" || saved === "erase" || saved === "shape" || saved === "text") return saved;
    } catch {
      /* 스토리지 차단 — 기본값 사용 */
    }
    return "pen";
  });
  const [shapeKind, setShapeKind] = useState<ShapeKind>("rect");
  const [color, setColor] = useState<string>(() => {
    try {
      const saved = localStorage.getItem(LS_COLOR);
      if (saved && COLORS.includes(saved)) return saved;
    } catch {
      /* 스토리지 차단 — 기본값 사용 */
    }
    return DEFAULT_COLOR;
  });
  useEffect(() => {
    try {
      localStorage.setItem(LS_TOOL, tool);
      localStorage.setItem(LS_COLOR, color);
    } catch {
      /* 유지 저장만 건너뛴다 */
    }
  }, [tool, color]);
  const [brushSize, setBrushSize] = useState(18); // 작업 해상도 px
  // 굵기 숫자칸에 치는 중인 글자 — null 이면 brushSize 를 보인다. Enter·바깥 누름에 4~120 으로 맞춰 적용.
  const [sizeText, setSizeText] = useState<string | null>(null);
  const applySizeText = () => {
    if (sizeText === null) return;
    const n = Math.round(Number(sizeText));
    if (sizeText.trim() && Number.isFinite(n)) setBrushSize(Math.min(120, Math.max(4, n)));
    setSizeText(null);
  };
  // 색 창 — 도구 캡슐 바깥을 누르면 닫힌다
  const [colorOpen, setColorOpen] = useState(false);
  const dockRef = useRef<HTMLDivElement>(null);
  useOutsideMouseDown(dockRef, () => setColorOpen(false), colorOpen);
  const annotRef = useRef<HTMLCanvasElement | null>(null);
  const liveRef = useRef<PenStroke | ShapeItem | null>(null);
  // 쓰는 중인 글자 — at = 누른 자리(작업 px), left·top = 무대 상자 기준 화면 px, scale = 화면 px / 작업 px.
  // 확정·취소는 ref 로 먼저 비운다 — 같은 누름에서 pointerdown 과 blur 가 함께 확정해 글자가 두 번 들어가지 않게.
  const [textDraft, setTextDraft] = useState<null | { at: { x: number; y: number }; left: number; top: number; scale: number; text: string }>(null);
  const textDraftRef = useRef(textDraft);
  textDraftRef.current = textDraft;
  const commitText = () => {
    const draft = textDraftRef.current;
    if (!draft) return;
    textDraftRef.current = null;
    setTextDraft(null);
    const text = draft.text.trim();
    if (!text) return;
    setItems((prev) => [...prev, { kind: "text", text, color, size: textPx(brushSize), at: draft.at }]);
    setRedo([]);
  };
  const cancelText = () => {
    textDraftRef.current = null;
    setTextDraft(null);
  };

  const renderAll = (list: DrawItem[], live?: DrawItem | null) => {
    const cv = annotRef.current;
    const ctx = cv?.getContext("2d");
    if (!cv || !ctx) return;
    ctx.save();
    ctx.clearRect(0, 0, cv.width, cv.height);
    for (const it of list) drawItem(ctx, it);
    if (live) drawItem(ctx, live);
    ctx.restore();
  };
  useEffect(() => {
    if (active) renderAll(items);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, items, src]);

  const activePointerRef = useRef<number | null>(null); // 멀티 포인터 혼선 방지 — 첫 포인터만
  // 브러시 크기 커서 미리보기 — 실제 칠해질 지름의 원을 포인터에 따라 표시(상태 없이
  // ref 직접 갱신: mousemove 마다 리렌더 없이). 도형 도구는 crosshair 만 쓰므로 숨긴다.
  const cursorRef = useRef<HTMLDivElement | null>(null);
  const cursorPosRef = useRef<{ x: number; y: number } | null>(null); // 무대 상자 기준 px
  const updateCursor = () => {
    const el = cursorRef.current;
    if (!el) return;
    const annot = annotRef.current;
    const pos = cursorPosRef.current;
    if (!pos || !annot || !src || !active || tool === "shape" || tool === "text") {
      el.style.display = "none";
      return;
    }
    const rect = annot.getBoundingClientRect();
    if (!rect.width) return;
    const d = brushSize * (rect.width / src.w); // 작업 px → 화면 px
    el.style.display = "block";
    el.style.left = `${pos.x}px`;
    el.style.top = `${pos.y}px`;
    el.style.width = `${d}px`;
    el.style.height = `${d}px`;
    el.classList.toggle("erase", tool === "erase");
    el.style.borderColor = tool === "erase" ? "" : color; // erase 는 클래스(흰 점선)가 결정
  };
  const trackCursor = (e: React.PointerEvent) => {
    const annot = annotRef.current;
    if (!annot) return;
    const rect = annot.getBoundingClientRect();
    cursorPosRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    updateCursor();
  };
  useEffect(() => {
    updateCursor(); // [ ] 크기·도구·색 변경 시 제자리에서 즉시 반영
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brushSize, tool, color, active]);
  const toWork = (e: React.PointerEvent) => {
    const annot = annotRef.current;
    if (!annot || !src) return null;
    const rect = annot.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return {
      x: ((e.clientX - rect.left) / rect.width) * src.w,
      y: ((e.clientY - rect.top) / rect.height) * src.h,
    };
  };
  const onPointerDown = (e: React.PointerEvent) => {
    if (!active || activePointerRef.current != null) return;
    const p = toWork(e);
    if (!p) return;
    if (onStrokeStart?.() === false) return;
    if (tool === "text") {
      // 쓰던 글자가 있으면 먼저 확정(이 누름은 확정만), 없으면 누른 자리에 입력칸을 연다.
      // preventDefault — 뒤따르는 mousedown 이 방금 연 입력칸의 초점을 빼앗지 않게.
      e.preventDefault();
      if (textDraftRef.current) { commitText(); return; }
      const rect = annotRef.current!.getBoundingClientRect();
      setTextDraft({ at: p, left: e.clientX - rect.left, top: e.clientY - rect.top, scale: rect.width / (src?.w || 1), text: "" });
      return;
    }
    // 캔버스에 그리기 시작 = 그리기 모드 복귀 — 프롬프트 포커스를 풀어 단축키([ ]·D·E·R·
    // Ctrl+Z)가 돌아오게 한다(입력은 프롬프트를 다시 클릭해야 재개).
    const activeEl = document.activeElement;
    if (activeEl instanceof HTMLElement && (activeEl.tagName === "TEXTAREA" || activeEl.isContentEditable)) activeEl.blur();
    activePointerRef.current = e.pointerId;
    (e.target as Element).setPointerCapture(e.pointerId);
    liveRef.current =
      tool === "shape"
        ? { kind: "shape", shape: shapeKind, color, size: brushSize, from: p, to: p }
        : { kind: "pen", erase: tool === "erase", color, size: brushSize, points: [p] };
    renderAll(items, liveRef.current);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    trackCursor(e); // 그리는 중이 아니어도 커서 원은 따라온다
    const live = liveRef.current;
    if (!live || e.pointerId !== activePointerRef.current) return;
    const p = toWork(e);
    if (!p) return;
    if (live.kind === "pen") live.points.push(p);
    else live.to = p;
    renderAll(items, live);
  };
  const onPointerLeave = () => {
    cursorPosRef.current = null;
    updateCursor();
  };
  const endStroke = (e: React.PointerEvent) => {
    if (e.pointerId !== activePointerRef.current) return;
    activePointerRef.current = null;
    const live = liveRef.current;
    if (!live) return;
    liveRef.current = null;
    // 도형은 드래그 없이 클릭만 한 것(크기 0)이면 버린다 — 보이지 않는 잉크 방지.
    if (live.kind === "shape" && Math.hypot(live.to.x - live.from.x, live.to.y - live.from.y) < 3) {
      renderAll(items);
      return;
    }
    setItems((prev) => [...prev, live]);
    setRedo([]);
  };
  // 취소 경로(pointercancel·capture 강탈)는 그리다 만 것을 커밋하지 않고 버린다 —
  // 특히 중단된 도형이 엉뚱한 크기로 남는 것 방지(코덱스 WARN). 정상 pointerup 뒤에
  // 오는 lostpointercapture 는 activePointerRef 가 이미 null 이라 no-op.
  const cancelStroke = (e: React.PointerEvent) => {
    if (e.pointerId !== activePointerRef.current) return;
    activePointerRef.current = null;
    liveRef.current = null;
    renderAll(items);
  };

  return {
    items, setItems, redo, setRedo, undoStroke, redoStroke, clearStrokes,
    tool, setTool, shapeKind, setShapeKind, color, setColor, brushSize, setBrushSize,
    sizeText, setSizeText, applySizeText, colorOpen, setColorOpen, dockRef,
    annotRef, cursorRef, textDraft, setTextDraft, textDraftRef, commitText, cancelText,
    renderAll, trackCursor, onPointerDown, onPointerMove, onPointerLeave, endStroke, cancelStroke,
  };
}

export type DrawingInput = ReturnType<typeof useDrawingInput>;
