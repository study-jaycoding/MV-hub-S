// GPU 판의 그릴 모델(순수) — SceneBoard 의 자료를 카드 그림 굽기 요청·카드 사각형·선·점·그룹 틀·이름표로 바꾼다
//  (docs/status/캔버스_GPU판설계_2026-11-11.md 「1단계 구현 설계」). 카드 모습은 boardCanvasDraw 가 그리고, 여기서는
//  모습 열쇠(위치를 뺀 그릴 것의 JSON)로 다시 구울지만 가른다 — 위치·선택 테두리·카메라는 열쇠 밖이다.
//  색·굵기는 styles/scene.css·history.css 의 값을 옮겨 적었다(바꾸면 같이 바꿀 것).
import { buildBoardItem, boardItemSources, drawBoardItem, BOARD_KINDS, type BoardBuildContext, type BoardItem } from "../../../lib/boardCanvasDraw";
import type { SceneCard } from "../../../lib/scenes";
import type { AtlasRequest } from "./cardAtlas";
import type { GpuCardInstance, GpuDot, GpuLine, GpuQuad, GpuRect } from "./gpuRenderer";

export type Rgba = [number, number, number, number];

const ACCENT = "#c8ef40";
const ACCENT_INK = "#111";
const FONT = '"Inter", "Segoe UI", system-ui, -apple-system, sans-serif';

/** '#rrggbb'·'#rgb' → 0..1 RGBA. 읽을 수 없는 색은 강조색. */
export function hexRgba(hex: string, alpha = 1): Rgba {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = /^[0-9a-f]{6}$/i.test(h) ? parseInt(h, 16) : 0xc8ef40;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, alpha];
}

/** 카드 종류의 틀 색(--pc). 리스트는 모은 종류(lk-*)의 색. */
export function cardColor(card: SceneCard, listKind: string | null): string {
  switch (card.kind) {
    case "reference": return "#7fa9ff";
    case "model": return "#ffb84d";
    case "text": return "#b57aff";
    case "list":
      return listKind === "reference" ? "#7fa9ff" : listKind === "text" ? "#b57aff" : listKind === "empty" ? "#8a909a"
        : listKind === "mixed" || listKind === "invalid" ? "#ff6b6b" : ACCENT;
    default: return ACCENT;
  }
}

// ── 연결선 ─────────────────────────────────────────────────────────────────────────
/** SVG path(M·L·C 만 — sceneEdges 의 edgePathXY·edgePathMerged·wireTracePath 가 내는 모양)를 점 목록으로 편다. */
export function flattenPath(d: string, segments = 16): number[] {
  const tok = d.replace(/,/g, " ").trim().split(/\s+/);
  const pts: number[] = [];
  let i = 0, cx = 0, cy = 0;
  const num = () => Number(tok[i++]);
  while (i < tok.length) {
    const cmd = tok[i++];
    if (cmd === "M" || cmd === "L") {
      cx = num(); cy = num();
      pts.push(cx, cy);
    } else if (cmd === "C") {
      const x1 = num(), y1 = num(), x2 = num(), y2 = num(), x3 = num(), y3 = num();
      for (let s = 1; s <= segments; s++) {
        const t = s / segments, u = 1 - t;
        pts.push(u * u * u * cx + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3, u * u * u * cy + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3);
      }
      cx = x3; cy = y3;
    } else break; // 모르는 명령 — 여기까지만(지금 만드는 path 에는 없다)
  }
  return pts;
}

export interface LineStyle { color: Rgba; width: number; dash: number; gap: number }

/** .scene-edge 클래스 문자열 → 색·굵기·대시. CSS 와 같은 순서로 덮는다(같은 특정성이라 뒤 규칙이 이긴다). 굵기·대시는 월드 단위(SVG 가 카메라 층 안). */
export function edgeStyle(cls: string): LineStyle {
  const has = new Set(cls.split(/\s+/));
  let color = ACCENT, width = 2.4, opacity = 0.85, dash = 0, gap = 0;
  const set = (c: string | null, w: number | null, o: number | null, d?: [number, number]) => {
    if (c) color = c;
    if (w != null) width = w;
    if (o != null) opacity = o;
    if (d) [dash, gap] = d;
  };
  if (has.has("ref")) set("#7fa9ff", 2.2, 0.9);
  if (has.has("refg")) set("#7fa9ff", null, null);
  if (has.has("model")) set("#ffb84d", 2.2, 0.9);
  if (has.has("text")) set("#b57aff", 2.2, 0.9);
  if (has.has("set")) set("#e8c341", 2.2, 0.9);
  if (has.has("idle")) set("#464b55", 1.2, 0.5, [0, 0]);
  if (has.has("onsel")) set(null, 1.6, 0.999);
  if (has.has("pending")) set("#8a8f98", null, 0.85, [6, 5]);
  if (has.has("cut")) set("#f2777c", 3, 1, [0, 0]);
  if (has.has("bridge")) set("#8a8f98", 1.2, 0.6, [2, 6]);
  if (has.has("trace")) set("#ff4d5e", 3, 0.999, [8, 6]);
  return { color: hexRgba(color, opacity), width, dash, gap };
}

/** .scene-dot 클래스 → 채움색(테두리 #14161a 2px, 반지름 5 — 월드 단위). */
export function dotColor(cls: string): Rgba {
  const has = new Set(cls.split(/\s+/));
  if (has.has("mix")) return hexRgba("#ffffff");
  if (has.has("idle")) return hexRgba("#464b55");
  if (has.has("ref")) return hexRgba("#7fa9ff");
  if (has.has("model")) return hexRgba("#ffb84d");
  if (has.has("text")) return hexRgba("#b57aff");
  if (has.has("set")) return hexRgba("#e8c341");
  return hexRgba(ACCENT);
}

// ── 입력·출력 ────────────────────────────────────────────────────────────────────────
export interface GpuSceneCard { card: SceneCard; w: number; h: number }
export interface GpuSceneGroup { id: string; x: number; y: number; w: number; h: number; color: string | null; name: string; count: number; collapsed: boolean; selected: boolean }
export interface GpuSceneInput {
  /** 그리는 순서(뒤가 앞) = DOM 의 카드 순서. 숨김·접힘은 SceneBoard 가 이미 뺀 목록 */
  cards: readonly GpuSceneCard[];
  build: BoardBuildContext;
  selected: ReadonlySet<string>;
  /** 방금 생성됨(라임 빛) */
  glow: ReadonlySet<string>;
  /** 서버에 없는 레퍼런스가 든 카드(고르면 빨간 테두리) */
  offServer: ReadonlySet<string>;
  listKind: (cardId: string) => string | null;
  /** 연결선 — path 와 .scene-edge 클래스 문자열(DOM SVG 와 같은 계산) */
  lines: ReadonlyArray<{ d: string; cls: string }>;
  /** 연결선 끝 점 — 좌표와 .scene-dot 클래스 */
  dots: ReadonlyArray<{ x: number; y: number; cls: string }>;
  groups: readonly GpuSceneGroup[];
  /** 25% 이하 단순화(data-lod-low) — 결과 수 배지·폴더 이름표·회색 끝 점을 숨긴다(고른 카드의 이름표는 남김) */
  lowLod: boolean;
  variantCount: (card: SceneCard) => number;
  folderChip: (card: SceneCard) => string | undefined;
  refTypeLabel: (card: SceneCard) => string;
}
export interface GpuSceneModel {
  requests: AtlasRequest[];
  cards: GpuCardInstance[];
  lines: GpuLine[];
  rects: GpuRect[];
  dots: GpuDot[];
  quads: GpuQuad[];
  /** 지원하지 않는 종류라 그릴 수 없는 카드 — 하나라도 있으면 GPU 판에 들어가지 않는다(gpuMode) */
  undrawable: string[];
}

const LABEL: Record<string, string> = { model: "모델", list: "리스트", text: "텍스트" };

/** 정렬된 JSON — 같은 값이면 같은 글(모습 열쇠). */
export function stableKey(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableKey).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => JSON.stringify(k) + ":" + stableKey(o[k])).join(",") + "}";
}

/** 위치를 뺀 그릴 것 — 굽기는 (0,0) 에서 한다. 열쇠에 id 는 넣지 않는다(같은 모습이면 같은 열쇠). */
function atOrigin(item: BoardItem): BoardItem {
  return { ...item, x: 0, y: 0 };
}

type TextQuad = { id: string; x: number; y: number; w: number; h: number; key: string; draw: AtlasRequest["draw"] };

function measure(text: string, size: number, weight: number): number {
  // 굽기 전 크기 어림 — 이름표 상자 폭(실제 글은 굽는 캔버스의 measureText 로 그린다). 한글은 대략 1em, 그 밖은 0.6em.
  let w = 0;
  for (const ch of text) w += /[ㄱ-힝]/.test(ch) ? size : size * (weight >= 700 ? 0.62 : 0.56);
  return Math.ceil(w);
}

function pillQuad(id: string, text: string, x: number, y: number, opts: { size: number; weight: number; padX: number; padY: number; radius: number; bg: string; fg: string; border?: string }): TextQuad {
  const w = measure(text, opts.size, opts.weight) + opts.padX * 2;
  const h = Math.ceil(opts.size * 1.5) + opts.padY * 2;
  return {
    id, x, y, w, h,
    key: stableKey(["pill", text, opts]),
    draw: (g) => {
      const r = Math.min(opts.radius, h / 2);
      g.beginPath();
      g.moveTo(r, 0);
      g.arcTo(w, 0, w, h, r);
      g.arcTo(w, h, 0, h, r);
      g.arcTo(0, h, 0, 0, r);
      g.arcTo(0, 0, w, 0, r);
      g.closePath();
      g.fillStyle = opts.bg;
      g.fill();
      if (opts.border) {
        g.strokeStyle = opts.border;
        g.lineWidth = 1;
        g.stroke();
      }
      g.font = `${opts.weight} ${opts.size}px ${FONT}`;
      g.fillStyle = opts.fg;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(text, w / 2, h / 2 + 0.5);
    },
  };
}

/** 그룹 머리줄(.scene-group-hd) — 이름·개수 알약·접기/색/× 자리. 단추는 보기 모드에서 누를 수 없어 모양만. */
function groupHeaderQuad(gv: GpuSceneGroup): TextQuad {
  const gc = gv.color || ACCENT;
  const w = Math.max(1, Math.round(gv.w)), h = 26;
  return {
    id: "group:" + gv.id, x: gv.x, y: gv.y, w, h,
    key: stableKey(["group", gv.name, gv.count, gc, gv.collapsed, gv.selected, w]),
    draw: (g) => {
      const [r, gg, b] = hexRgba(gc);
      const mix = (k: number, base: [number, number, number, number]) =>
        `rgba(${Math.round((r * k + (base[0] / 255) * (1 - k)) * 255)},${Math.round((gg * k + (base[1] / 255) * (1 - k)) * 255)},${Math.round((b * k + (base[2] / 255) * (1 - k)) * 255)},${base[3] * (1 - k) + k})`;
      if (!gv.collapsed || gv.selected) {
        g.beginPath();
        g.moveTo(10, 0);
        g.arcTo(w, 0, w, h, 10);
        g.lineTo(w, h);
        g.lineTo(0, h);
        g.arcTo(0, 0, w, 0, 10);
        g.closePath();
        g.fillStyle = gv.selected ? mix(0.26, [20, 22, 26, 0.84]) : mix(0.36, [20, 22, 26, 0.72]);
        g.fill();
      }
      g.font = `700 12px ${FONT}`;
      g.textAlign = "left";
      g.textBaseline = "middle";
      g.fillStyle = "#e6e8ec";
      const nameMax = Math.max(0, w - 8 - 90);
      let name = gv.name;
      while (name && g.measureText(name).width > nameMax) name = name.slice(0, -1); // 끝 줄임표 없이 자른다(글자 끝 '...' 금지)
      g.fillText(name, 8, h / 2);
      const nx = 8 + g.measureText(name).width + 6;
      g.font = `800 11px ${FONT}`;
      const cw = g.measureText(String(gv.count)).width + 14;
      g.beginPath();
      g.moveTo(nx + 8, h / 2 - 8);
      g.arcTo(nx + cw, h / 2 - 8, nx + cw, h / 2 + 8, 8);
      g.arcTo(nx + cw, h / 2 + 8, nx, h / 2 + 8, 8);
      g.arcTo(nx, h / 2 + 8, nx, h / 2 - 8, 8);
      g.arcTo(nx, h / 2 - 8, nx + cw, h / 2 - 8, 8);
      g.closePath();
      g.fillStyle = gc;
      g.fill();
      g.fillStyle = ACCENT_INK;
      g.textAlign = "center";
      g.fillText(String(gv.count), nx + cw / 2, h / 2 + 0.5);
      // 오른쪽 단추 자리 — 접기(▾/▸)·색 견본·×
      g.fillStyle = "#e6e8ec";
      g.font = `700 12px ${FONT}`;
      g.fillText(gv.collapsed ? "▸" : "▾", w - 8 - 18 - 6 - 16 - 6 - 12, h / 2 + 0.5);
      g.fillStyle = gc;
      g.fillRect(w - 8 - 18 - 6 - 16, h / 2 - 8, 16, 16);
      g.fillStyle = "#8a909a";
      g.fillText("×", w - 8 - 9, h / 2 + 0.5);
    },
  };
}

/** SceneBoard 자료 → GPU 판 모델. 같은 입력이면 같은 출력(시험 가능). */
export function buildGpuScene(input: GpuSceneInput): GpuSceneModel {
  const requests: AtlasRequest[] = [];
  const cards: GpuCardInstance[] = [];
  const rects: GpuRect[] = [];
  const quads: GpuQuad[] = [];
  const undrawable: string[] = [];
  const textQuads: TextQuad[] = [];

  // 그룹 틀(.scene-group) — 면은 그룹 색 13%(고르면 20%), 테두리는 고를 때만 밝힌 2px. 접힌 막대는 어두운 면.
  for (const gv of input.groups) {
    const gc = gv.color || ACCENT;
    rects.push({
      x: gv.x, y: gv.y, w: gv.w, h: gv.h, radius: gv.collapsed ? 10 : 12,
      fill: gv.collapsed ? [20 / 255, 22 / 255, 26 / 255, 0.92] : hexRgba(gc, gv.selected ? 0.2 : 0.13),
      border: gv.selected ? lighten(hexRgba(gc), 0.3) : [0, 0, 0, 0],
      borderWidth: gv.selected ? 2 : 0,
    });
    textQuads.push(groupHeaderQuad(gv));
  }

  input.cards.forEach(({ card, w, h }, z) => {
    if (!BOARD_KINDS.has(card.kind)) {
      undrawable.push(card.id);
      return;
    }
    const item = buildBoardItem(card, { id: card.id, x: card.x, y: card.y, w, h }, input.build);
    if (!item) {
      undrawable.push(card.id);
      return;
    }
    const body = atOrigin(item);
    const { id: _id, ...shape } = body; // 열쇠엔 id 를 넣지 않는다
    requests.push({
      id: card.id, key: stableKey(shape), w, h,
      sources: boardItemSources(item),
      draw: (g, imageOf) => drawBoardItem(g as never, body, imageOf),
    });
    const sel = input.selected.has(card.id);
    const glow = input.glow.has(card.id);
    const pc = cardColor(card, card.kind === "list" ? input.listKind(card.id) : null);
    const isHead = card.kind === "head";
    const border: Rgba = isHead ? [0, 0, 0, 0] : sel && input.offServer.has(card.id) ? hexRgba("#ff6b6b") : sel || glow ? hexRgba(pc) : [0, 0, 0, 0];
    cards.push({ id: card.id, x: card.x, y: card.y, w, h, radius: isHead ? 0 : 12, border, borderWidth: isHead ? 0 : 2, hidden: false, z });
    if (glow && !isHead) {
      // .scene-card.glow::after — 노드 색 빛(멈춰 있는 26px 번짐을 바깥 띠 두 겹으로)
      rects.push({ x: card.x - 6, y: card.y - 6, w: w + 12, h: h + 12, radius: 18, fill: [0, 0, 0, 0], border: hexRgba(pc, 0.45), borderWidth: 6 });
      rects.push({ x: card.x - 14, y: card.y - 14, w: w + 28, h: h + 28, radius: 26, fill: [0, 0, 0, 0], border: hexRgba(pc, 0.18), borderWidth: 8 });
    }
    if (isHead && sel) {
      // .scene-card-head.sel — 점선 바깥선(1.5px·3px 띄움)을 옅은 실선으로
      rects.push({ x: card.x - 4.5, y: card.y - 4.5, w: w + 9, h: h + 9, radius: 2, fill: [0, 0, 0, 0], border: [1, 1, 1, 0.35], borderWidth: 1.5 });
    }
    // 카드 밖 조각 — 고른 카드의 이름표(.scene-card-hd-float: 위로 8px, 13px)·결과 수(▤ n, 위 4px 가운데)·폴더 이름표(아래 변 가운데)
    const label = card.kind === "reference" ? input.refTypeLabel(card) : LABEL[card.kind];
    if (sel && label) {
      const q = pillQuad("label:" + card.id, label, card.x, 0, {
        size: 13, weight: 800, padX: 11, padY: 5, radius: 8, bg: mixRgbaCss(pc, 0.12, [12, 14, 18, 0.94]), fg: pc,
      });
      q.y = card.y - 8 - q.h;
      textQuads.push(q);
    }
    if (!input.lowLod && card.kind === "generation") {
      const n = input.variantCount(card);
      if (n > 1) {
        const q = pillQuad("multi:" + card.id, `▤ ${n}`, 0, 0, { size: 12, weight: 800, padX: 11, padY: 3, radius: 8, bg: ACCENT, fg: ACCENT_INK, border: "rgba(0,0,0,0.25)" });
        q.x = card.x + w / 2 - q.w / 2;
        q.y = card.y - 4 - q.h;
        textQuads.push(q);
      }
      const chip = input.folderChip(card);
      if (chip && item.kind === "generation" && item.state === "done") {
        const q = pillQuad("folder:" + card.id, chip, 0, 0, { size: 11, weight: 600, padX: 10, padY: 2, radius: 9, bg: "rgba(8,9,12,0.34)", fg: "rgba(255,255,255,0.9)", border: "rgba(255,255,255,0.14)" });
        q.w = Math.min(q.w, Math.max(0, w - 16));
        q.x = card.x + w / 2 - q.w / 2;
        q.y = card.y + h - q.h - (item.color || item.final ? 9 : 0);
        textQuads.push(q);
      }
    }
  });

  for (const q of textQuads) {
    requests.push({ id: q.id, key: q.key, w: q.w, h: q.h, sources: [], draw: q.draw });
    quads.push({ id: q.id, x: q.x, y: q.y, w: q.w, h: q.h });
  }

  const lines: GpuLine[] = input.lines.map(({ d, cls }) => {
    const st = edgeStyle(cls);
    return { points: new Float32Array(flattenPath(d)), color: st.color, width: st.width, dash: st.dash, gap: st.gap };
  });
  const dots: GpuDot[] = input.dots
    .filter((p) => !(input.lowLod && /\bidle\b/.test(p.cls)))
    .map((p) => ({ x: p.x, y: p.y, r: 5, fill: dotColor(p.cls), border: hexRgba("#14161a") }));
  return { requests, cards, lines, rects, dots, quads, undrawable };
}

function lighten(c: Rgba, k: number): Rgba {
  return [c[0] + (1 - c[0]) * k, c[1] + (1 - c[1]) * k, c[2] + (1 - c[2]) * k, c[3]];
}

/** color-mix(in srgb, <hex> k, rgba(base)) 근사 */
function mixRgbaCss(hex: string, k: number, base: [number, number, number, number]): string {
  const [r, g, b] = hexRgba(hex);
  return `rgba(${Math.round((r * k + (base[0] / 255) * (1 - k)) * 255)},${Math.round((g * k + (base[1] / 255) * (1 - k)) * 255)},${Math.round((b * k + (base[2] / 255) * (1 - k)) * 255)},${(base[3] * (1 - k) + k).toFixed(3)})`;
}
