// 그리기 획 — 수정 창(PartialEditModal)과 코멘트 그림(CommentDrawModal)이 함께 쓰는 그리기 규칙과
// 코멘트 그림 '획 목록 v1' 규격(설계 docs/status/크게보기_코멘트그림_설계_2026-11-05.md §10 C4).
// 서버 backend/app/services/comment_strokes.py 와 **같은 바이트**로 정규화·해시한다:
//  · 숫자는 소수 1자리(시각은 ms), 0.5 는 올림 = Math.floor(x*10+0.5)/10 · 정수면 정수(JSON.stringify(2) == "2")
//  · JSON 은 칸 이름 정렬·공백 없음(파이썬 ensure_ascii=False 와 같은 출력 — 제어 문자는 넣지 않는다)

export interface PenStroke {
  kind: "pen";
  erase: boolean;
  color: string;
  size: number; // 그리는 캔버스 px
  points: { x: number; y: number }[];
}
export type ShapeKind = "line" | "arrow" | "rect" | "ellipse";
export interface ShapeItem {
  kind: "shape";
  shape: ShapeKind;
  color: string;
  size: number;
  from: { x: number; y: number };
  to: { x: number; y: number };
}
// 글자 — 누른 자리(at)가 글자 상자의 왼쪽 위. size 는 글자 높이(px).
export interface TextItem {
  kind: "text";
  text: string;
  color: string;
  size: number;
  at: { x: number; y: number };
}
export type DrawItem = PenStroke | ShapeItem | TextItem;

// 펜 컬러 스와치 — 웹 편집기의 구성(흰·라임·주황·빨강·민트·파랑·분홍·검정). 서버 PALETTE 와 같다.
export const COLORS = ["#ffffff", "#bef264", "#f59e0b", "#ef4444", "#2dd4bf", "#3b82f6", "#ec4899", "#111111"];
export const DEFAULT_COLOR = "#ef4444"; // 레드
export const TEXT_FONT = '700 {px}px "Pretendard", "Malgun Gothic", "Apple SD Gothic Neo", sans-serif';
// 굵기(brushSize) → 글자 높이. 같은 슬라이더로 펜 굵기와 글자 크기를 함께 정한다(2배는 작은 그림에서 너무 컸다 — 10-28 실측).
export const textPx = (brush: number) => Math.round(brush * 1.5);

function drawPen(ctx: CanvasRenderingContext2D, stroke: PenStroke) {
  ctx.globalCompositeOperation = stroke.erase ? "destination-out" : "source-over";
  ctx.strokeStyle = stroke.erase ? "#ffffff" : stroke.color;
  ctx.fillStyle = ctx.strokeStyle;
  ctx.lineWidth = stroke.size;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const pts = stroke.points;
  if (pts.length === 1) {
    ctx.beginPath();
    ctx.arc(pts[0].x, pts[0].y, stroke.size / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.stroke();
}

function drawShape(ctx: CanvasRenderingContext2D, s: ShapeItem) {
  ctx.globalCompositeOperation = "source-over";
  ctx.strokeStyle = s.color;
  ctx.lineWidth = s.size;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const { from, to } = s;
  if (s.shape === "rect") {
    ctx.strokeRect(Math.min(from.x, to.x), Math.min(from.y, to.y), Math.abs(to.x - from.x), Math.abs(to.y - from.y));
    return;
  }
  if (s.shape === "ellipse") {
    ctx.beginPath();
    ctx.ellipse((from.x + to.x) / 2, (from.y + to.y) / 2, Math.abs(to.x - from.x) / 2, Math.abs(to.y - from.y) / 2, 0, 0, Math.PI * 2);
    ctx.stroke();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  if (s.shape === "arrow") {
    // 화살촉 — 선 끝(to)에서 150° 로 짧은 두 선. 굵기에 비례하되 최소 길이 보장.
    const ang = Math.atan2(to.y - from.y, to.x - from.x);
    const len = Math.max(s.size * 2.5, 14);
    for (const off of [(Math.PI * 5) / 6, -(Math.PI * 5) / 6]) {
      ctx.beginPath();
      ctx.moveTo(to.x, to.y);
      ctx.lineTo(to.x + Math.cos(ang + off) * len, to.y + Math.sin(ang + off) * len);
      ctx.stroke();
    }
  }
}

// 글자는 굵게 + 얇은 어두운 테두리 — 밝은 바탕·어두운 바탕 어디서나 읽게.
function drawText(ctx: CanvasRenderingContext2D, t: TextItem) {
  ctx.globalCompositeOperation = "source-over";
  ctx.font = TEXT_FONT.replace("{px}", String(t.size));
  ctx.textBaseline = "top";
  ctx.lineJoin = "round";
  ctx.lineWidth = Math.max(2, t.size / 8);
  ctx.strokeStyle = "rgba(0, 0, 0, 0.6)";
  ctx.fillStyle = t.color;
  ctx.strokeText(t.text, t.at.x, t.at.y);
  ctx.fillText(t.text, t.at.x, t.at.y);
}

export function drawItem(ctx: CanvasRenderingContext2D, it: DrawItem) {
  if (it.kind === "pen") drawPen(ctx, it);
  else if (it.kind === "text") drawText(ctx, it);
  else drawShape(ctx, it);
}

/** 획 목록을 캔버스에 다시 그린다 — scale = 캔버스 px / 좌표계 px. 지우개는 이 주석 층에서만 지운다(원본은 아래 층). */
export function renderStrokes(ctx: CanvasRenderingContext2D, items: DrawItem[], scale = 1) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  for (const it of items) drawItem(ctx, it);
  ctx.restore();
}

// ── 획 목록 v1(코멘트 그림) ────────────────────────────────────────────────
export interface StrokesV1 {
  v: 1;
  items: DrawItem[];
}
export const MAX_DRAWINGS = 12;
const MAX_ITEMS = 500;
const MAX_PEN_POINTS = 5000;
const MAX_TOTAL_POINTS = 20000;
const MAX_TEXT = 200;

const q = (value: number, scale: number) => Math.floor(value * scale + 0.5) / scale;
export const quantize = (value: number) => q(value, 10);
export const quantizeTime = (value: number) => q(value, 1000);
export const sizeLimit = (width: number, height: number) => Math.max(180, Math.max(width, height) / 4);

/** 칸 이름 정렬·공백 없음 — 파이썬 json.dumps(sort_keys, separators=(",", ":"), ensure_ascii=False) 와 같은 글자. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export class StrokesTooLarge extends Error {}

/** 그리는 캔버스(work) 좌표의 획 → 원본 좌표계(width×height)의 v1 문서. 범위 밖 점은 가장자리로, 한도를 넘으면 StrokesTooLarge. */
export function toStrokesV1(items: DrawItem[], work: { w: number; h: number }, width: number, height: number): StrokesV1 {
  if (!items.length) throw new StrokesTooLarge("그린 것이 없습니다");
  if (items.length > MAX_ITEMS) throw new StrokesTooLarge(`그림 한 장에 획은 ${MAX_ITEMS}개까지입니다`);
  const sx = width / work.w;
  const sy = height / work.h;
  const limit = sizeLimit(width, height);
  const pt = (p: { x: number; y: number }) => ({
    x: quantize(Math.min(width, Math.max(0, p.x * sx))),
    y: quantize(Math.min(height, Math.max(0, p.y * sy))),
  });
  // 상한은 소수 1자리로 내림 — 올림한 값이 서버 상한(긴 변/4)을 넘지 않게
  const size = (s: number) => {
    const v = quantize(Math.max(1, s * Math.max(sx, sy)));
    return v > limit ? Math.floor(limit * 10) / 10 : v;
  };
  let total = 0;
  const out = items.map((it): DrawItem => {
    if (it.kind === "pen") {
      total += it.points.length;
      if (it.points.length > MAX_PEN_POINTS || total > MAX_TOTAL_POINTS) {
        throw new StrokesTooLarge("획이 너무 길어 저장할 수 없습니다 — 나눠서 그려 주세요");
      }
      return { kind: "pen", erase: it.erase, color: it.color, size: size(it.size), points: it.points.map(pt) };
    }
    if (it.kind === "shape") return { kind: "shape", shape: it.shape, color: it.color, size: size(it.size), from: pt(it.from), to: pt(it.to) };
    // 글자는 코드 포인트로 200자·제어 문자 없이(서버 규칙과 같게 — 짝 없는 서로게이트도 뺀다)
    const text = Array.from(it.text.replace(/\p{Cc}/gu, "").replace(/[\uD800-\uDFFF]/g, "")).slice(0, MAX_TEXT).join("");
    return { kind: "text", text: text || " ", color: it.color, size: size(it.size), at: pt(it.at) };
  });
  return { v: 1, items: out };
}

async function sha256Hex(data: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 그림의 내용 해시(C4) — 그림 id 는 넣지 않는다. 브라우저가 해시를 못 하면(안전하지 않은 주소) null — 서버가 혼자 계산한다. */
export async function drawingHash(d: {
  strokes: StrokesV1; kind: "image" | "video"; width: number; height: number; timeSec: number | null; idx: number; thumb: Uint8Array<ArrayBuffer> | null;
}): Promise<string | null> {
  if (typeof crypto === "undefined" || !crypto.subtle) return null;
  const envelope = {
    v: 1, kind: d.kind, width: d.width, height: d.height,
    time_sec: d.timeSec == null ? null : quantizeTime(d.timeSec),
    idx: d.idx, strokes: d.strokes,
    thumb_sha256: d.thumb ? await sha256Hex(d.thumb) : null,
  };
  return sha256Hex(new TextEncoder().encode(canonical(envelope)));
}
