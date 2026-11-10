// 멀리 볼 때 카드 몸통을 판 한 장 canvas 에 그리는 순수 계산·그리기(docs/status/캔버스_보드그림판_2026-11-10.md).
//  buildBoardItem = 카드 하나를 '그릴 것'으로 바꾼다(기존 표시 계산을 그대로 부른다). 그릴 수 없으면(영상·오디오·그림 주소 없음) null → 그 카드는 DOM 몸통.
//  drawBoardItem = 25% 화면에 보이는 정보만 그린다(이름표·포트·크기 손잡이·번호 같은 LOD 가 숨기는 조각은 그리지 않는다).
import { inBoardFolder, matchesBoardFilters, type BoardFilters, type BoardFolderSelection } from "./boardFilters";
import { generationStatusLabelFor } from "./generationDisplay";
import { thumbOf } from "./media";
import { ownEntry } from "./ownEntry";
import { heldText, refHeldInfo, refServerStatus } from "./sceneAssetRelink";
import { CARD_W } from "./sceneDerive";
import { collectListInputs, effectiveTextOf } from "./sceneEdges";
import { refMediaType, refThumbSrc } from "./sceneMedia";
import { variantIds, type SceneCard, type SceneEdge } from "./scenes";
import { isDraftGeneration } from "./seedanceDraft";
import { spotlightParamLabel, spotlightValueLabel } from "./spotlightPromptConfig";
import { TEXT_TOKEN_SRC, textTokenInfo, textViewBudget, cutTextForView, type TextTokenKind } from "./textNodeTokens";
import type { Generation } from "../types";

/** 그림판이 그리는 종류 — 세트·머리글·Comfy·View·Input·Output·Render 는 DOM 그대로. */
export const BOARD_KINDS: ReadonlySet<string> = new Set(["reference", "list", "text", "model", "generation"]);

type TileStatus = "ok" | "local" | "missing" | "held" | "incomplete";
interface Tile { src: string | null; status: TileStatus; title?: string; name?: string; count?: number; mark?: boolean }
interface Box { id: string; x: number; y: number; w: number; h: number }
export type BoardItem = Box & (
  | { kind: "reference"; single: boolean; fill: boolean; tiles: Tile[] }
  | { kind: "text"; text: string }
  | { kind: "model"; name: string | null; type: string; blocked: boolean; params: Array<[string, string]> }
  | { kind: "list"; mode: "thumbs" | "rows" | "label"; label: string; thumbPx: number; tiles: Tile[]; rows: Array<{ src: string | null; text: string }> }
  | { kind: "generation"; state: "empty" | "blank" | "loading" | "fail" | "deleted" | "done"; label: string; src: string | null; fill: boolean;
      dim: boolean; final: boolean; shared: boolean; held: boolean; color: string | null; draft: boolean; logo: string }
);

export interface BoardBuildContext {
  workspaceId: string;
  fill: boolean;
  cardsById: Map<string, SceneCard>;
  resolvedEdges: SceneEdge[];
  genData: Record<string, Generation>;
  filters: BoardFilters;
  folderSel: BoardFolderSelection;
  modelBlocked: (model: string) => boolean;
  /** GenerationCard 에 넘기는 것과 같은 판정 — waiting(상류 comfy 대기)·genMissing·genKnown·비활성·실패 숨김·마지막 열람 카드 */
  waiting: (cardId: string) => boolean;
  genMissing: (genId: string) => boolean;
  genKnown: (genId: string) => boolean;
  disabled: (genId: string) => boolean;
  hideFailed: boolean;
  lastViewedCardId: string | null;
  logo: string;
}

const tileStatus = (workspaceId: string, ref: Parameters<typeof refServerStatus>[1]): TileStatus => refServerStatus(workspaceId, ref) ?? "ok";

/** 카드 하나를 그릴 것으로. null = 그리지 않는다(DOM 몸통) — 보일 미디어가 영상·오디오이거나 필요한 그림 주소가 없다. */
export function buildBoardItem(card: SceneCard, box: Box, ctx: BoardBuildContext): BoardItem | null {
  if (card.kind === "reference") {
    const refs = card.refs || [];
    if (!refs.length) return null;
    const tiles: Tile[] = [];
    for (const r of refs) {
      if (refMediaType(r) !== "image") return null;
      const status = tileStatus(ctx.workspaceId, r);
      const name = r.name || r.file_path.split("|").pop()?.split("/").pop() || r.file_path;
      if (status === "missing" || status === "held" || status === "incomplete") {
        const held = status === "held" ? refHeldInfo(ctx.workspaceId, r) : undefined;
        tiles.push({ src: null, status, name, title: status === "missing" ? "서버에 없음" : status === "held" && held ? heldText(held).title : "확인 못 함" });
        continue;
      }
      const src = refThumbSrc(r);
      if (!src) return null;
      tiles.push({ src, status, name });
    }
    return { ...box, kind: "reference", single: refs.length <= 1, fill: ctx.fill, tiles };
  }
  if (card.kind === "text") return { ...box, kind: "text", text: card.text || "" };
  if (card.kind === "model") {
    const cfg = card.modelCfg;
    const params: Array<[string, string]> = cfg?.params ? Object.entries(cfg.params).map(([k, v]) => [spotlightParamLabel(k), spotlightValueLabel(String(v), k)]) : [];
    return { ...box, kind: "model", name: cfg?.model ? cfg.modelName || cfg.model : null, type: cfg?.type || "", blocked: !!cfg?.model && ctx.modelBlocked(cfg.model), params };
  }
  if (card.kind === "list") {
    const li = collectListInputs(card.id, ctx.cardsById, ctx.resolvedEdges);
    const thumbPx = Math.max(42, Math.min(Math.round(((CARD_W * 2) / 3) * 1.5), Math.round((box.w / CARD_W) * 42)));
    const label = li.kind === "generation" ? `생성물 ${li.generationCardIds.length}개` : li.kind === "text" ? `텍스트 ${li.sourceIds.length}개`
      : li.kind === "reference" ? `레퍼런스 ${li.referenceCardIds.length}개` : li.kind === "mixed" ? "⚠ 혼합 입력(사용 불가)"
        : li.kind === "invalid" ? "⚠ 잘못된 입력" : "생성/텍스트/레퍼런스\n노드 연결";
    if (li.kind === "reference") {
      const tiles: Tile[] = [];
      for (const cid of li.referenceCardIds) {
        const rc = ctx.cardsById.get(cid);
        if (rc && rc.kind !== "reference") {
          const gid = rc.genId || variantIds(rc)[0];
          const gen = gid ? ownEntry(ctx.genData, gid) : undefined;
          const type = gen?.assets?.[0]?.type;
          if (type === "audio" || type === "video") return null;
          const src = gen ? thumbOf(gen, 128) : null;
          tiles.push({ src, status: "ok" });
          continue;
        }
        const refs = rc?.refs || [];
        if (refs[0] && refMediaType(refs[0]) !== "image") return null;
        const statuses = refs.map((r) => refServerStatus(ctx.workspaceId, r));
        const first = statuses[0];
        if (first === "missing" || first === "held") {
          tiles.push({ src: null, status: first, count: refs.length });
          continue;
        }
        const src = refs[0] ? refThumbSrc(refs[0]) ?? null : null;
        if (refs[0] && !src) return null;
        tiles.push({ src, status: "ok", count: refs.length, mark: statuses.some((st) => st && st !== "incomplete") });
      }
      return { ...box, kind: "list", mode: "thumbs", label, thumbPx, tiles, rows: [] };
    }
    if (li.kind === "text") {
      const rows = li.sourceIds.map((cid) => ({ src: null, text: effectiveTextOf(cid, ctx.cardsById, ctx.resolvedEdges).trim() || "(빈 텍스트)" }));
      return { ...box, kind: "list", mode: "rows", label, thumbPx, tiles: [], rows };
    }
    if (li.kind === "generation") {
      const rows: Array<{ src: string | null; text: string }> = [];
      for (const cid of li.sourceIds) {
        const gc = ctx.cardsById.get(cid);
        const gid = gc?.genId || (gc ? variantIds(gc)[0] : undefined);
        const gen = gid ? ownEntry(ctx.genData, gid) : undefined;
        const type = gen?.assets?.[0]?.type;
        if (type === "audio" || type === "video") return null;
        rows.push({ src: gen ? thumbOf(gen, 128) : null, text: gen?.prompt?.slice(0, 80) || "생성물" });
      }
      return { ...box, kind: "list", mode: "rows", label, thumbPx, tiles: [], rows };
    }
    return { ...box, kind: "list", mode: "label", label, thumbPx, tiles: [], rows: [] };
  }
  if (card.kind === "generation") {
    // GenerationCard 의 갈래를 같은 순서로 — 대기 → 완료(히스토리 노드) → 삭제됨 → 실패 → 답 전 → 생성 중 → 빈 카드.
    //  마지막 열람 배지·비활성 노드는 그리지 않는다(DOM) — 드문 조각이라 그림판이 따라 그리지 않는다.
    if (card.id === ctx.lastViewedCardId) return null;
    const g = card.genId ? ownEntry(ctx.genData, card.genId) : undefined;
    const base = { ...box, kind: "generation" as const, fill: ctx.fill, logo: ctx.logo, src: null, dim: false, final: false, shared: false, held: false, color: null, draft: false, label: "" };
    if (ctx.waiting(card.id)) return { ...base, state: "loading" };
    if (g && String(g.status) === "done") {
      if (ctx.disabled(g.id)) return null;
      const type = g.assets?.[0]?.type;
      if (type === "video" || type === "audio") return null;
      const src = thumbOf(g);
      if (!src) return null;
      return { ...base, state: "done", src, final: !!g.is_final, shared: !!g.shared, held: !!g.is_held, color: g.color || null, draft: isDraftGeneration(g),
        dim: !matchesBoardFilters(g, ctx.filters) || !inBoardFolder(g, ctx.folderSel) };
    }
    if (!card.genId) return { ...base, state: "empty" };
    if (ctx.genMissing(card.genId)) return { ...base, state: "deleted" };
    const status = String(g?.status || "");
    if (status === "failed" || status === "nsfw" || status === "error") {
      const st = status === "error" ? "failed" : status;
      return { ...base, state: "fail", label: generationStatusLabelFor(st, g?.error, g?.execution_phase), dim: ctx.hideFailed };
    }
    if (!g && !ctx.genKnown(card.genId) && !card.pendingGenerationAttempts?.length) return { ...base, state: "blank" };
    const shown = String(g?.status || card.status || "pending");
    return { ...base, state: "loading", label: generationStatusLabelFor(shown, g?.error, g?.execution_phase) };
  }
  return null;
}

/** 이 그릴 것이 쓰는 그림 주소(그림판이 불러 둔다·실패 주소 판정). */
export function boardItemSources(item: BoardItem): string[] {
  if (item.kind === "reference") return item.tiles.flatMap((t) => (t.src ? [t.src] : []));
  if (item.kind === "list") return [...item.tiles.flatMap((t) => (t.src ? [t.src] : [])), ...item.rows.flatMap((r) => (r.src ? [r.src] : []))];
  if (item.kind === "generation") return item.state === "done" && item.src ? [item.src] : item.state === "empty" || item.state === "loading" ? [item.logo] : [];
  return [];
}

// ── 그리기 ────────────────────────────────────────────────────────────────────────
type Ctx2D = Pick<CanvasRenderingContext2D, "save" | "restore" | "beginPath" | "rect" | "clip" | "fill" | "stroke" | "fillRect" | "fillText" | "drawImage" |
  "measureText" | "moveTo" | "lineTo" | "arcTo" | "closePath"> & { fillStyle: unknown; strokeStyle: unknown; font: string; lineWidth: number; globalAlpha: number; textAlign: CanvasTextAlign; textBaseline: CanvasTextBaseline };
type ImageOf = (src: string) => CanvasImageSource | null;

const CARD_BG = "#0c0d11";
const MUTED = "#8a909a";
const TEXT = "#e6e8ec";
const ACCENT = "#c8ef40";
const HATCH = ["#15171d", "#0f1116"];
const HATCH_OFF = ["#1f1215", "#140c0e"];
const HATCH_GEN = ["#0f141c", "#0d1118"];
const FONT = '"Inter", "Segoe UI", system-ui, -apple-system, sans-serif'; // styles/base.css 의 body 글꼴과 같게(줄바꿈 자리가 같아진다)

function roundRect(g: Ctx2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  g.beginPath();
  g.moveTo(x + rr, y);
  g.arcTo(x + w, y, x + w, y + h, rr);
  g.arcTo(x + w, y + h, x, y + h, rr);
  g.arcTo(x, y + h, x, y, rr);
  g.arcTo(x, y, x + w, y, rr);
  g.closePath();
}

/** 45° 빗금 — CSS repeating-linear-gradient 를 띠 몇 개로(25% 에서는 줄 몇 개면 같은 인상) */
function hatch(g: Ctx2D, x: number, y: number, w: number, h: number, colors: string[], band: number): void {
  g.save();
  g.beginPath();
  g.rect(x, y, w, h);
  g.clip();
  g.fillStyle = colors[0];
  g.fillRect(x, y, w, h);
  g.strokeStyle = colors[1];
  g.lineWidth = band * 0.7;
  g.beginPath();
  for (let d = -h; d < w + h; d += band * 1.41) {
    g.moveTo(x + d, y + h);
    g.lineTo(x + d + h, y);
  }
  g.stroke();
  g.restore();
}

function image(g: Ctx2D, img: CanvasImageSource | null, x: number, y: number, w: number, h: number, cover: boolean, ph: string[]): void {
  if (!img) return hatch(g, x, y, w, h, ph, 4);
  const iw = (img as HTMLImageElement).naturalWidth || (img as { width?: number }).width || w;
  const ih = (img as HTMLImageElement).naturalHeight || (img as { height?: number }).height || h;
  const s = cover ? Math.max(w / iw, h / ih) : Math.min(w / iw, h / ih);
  const dw = iw * s, dh = ih * s;
  g.save();
  g.beginPath();
  g.rect(x, y, w, h);
  g.clip();
  g.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  g.restore();
}

function text(g: Ctx2D, s: string, x: number, y: number, size: number, color: string, weight = 400, align: CanvasTextAlign = "left"): void {
  g.font = `${weight} ${size}px ${FONT}`;
  g.fillStyle = color;
  g.textAlign = align;
  g.textBaseline = "alphabetic";
  g.fillText(s, x, y);
}

function offMark(g: Ctx2D, x: number, y: number, size: number): void {
  roundRect(g, x, y, size, size, size * 0.25);
  g.save();
  g.clip();
  hatch(g, x, y, size, size, HATCH_OFF, 3);
  g.restore();
  g.strokeStyle = "#ff6b6b";
  g.lineWidth = 1.2;
  roundRect(g, x + size * 0.25, y + size * 0.3, size * 0.5, size * 0.4, size * 0.15);
  g.stroke();
}

/** 글 칸 — 줄바꿈(pre-wrap)·토큰 알약. 높이를 넘는 줄은 그리지 않는다. */
function textBlock(g: Ctx2D, raw: string, x: number, y: number, w: number, h: number): void {
  const size = 12, lh = size * 1.7;
  const maxLines = Math.max(1, Math.floor(h / lh));
  const re = new RegExp(TEXT_TOKEN_SRC, "g");
  g.font = `400 ${size}px ${FONT}`;
  g.textAlign = "left";
  g.textBaseline = "alphabetic";
  let line = 0, cx = 0;
  const newline = () => { line += 1; cx = 0; return line < maxLines; };
  const pillColor: Record<TextTokenKind, string> = { image: "#9ec5ff", start: "#fcd34d", end: "#fcd34d", video: ACCENT, audio: "#d8b4fe" };
  for (const para of raw.split("\n")) {
    const parts: Array<{ t: string; kind?: TextTokenKind }> = [];
    let last = 0, m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(para))) {
      if (m.index > last) parts.push({ t: para.slice(last, m.index) });
      const info = textTokenInfo(m);
      parts.push({ t: info.label, kind: info.kind });
      last = m.index + m[0].length;
    }
    if (last < para.length) parts.push({ t: para.slice(last) });
    for (const part of parts) {
      if (part.kind) {
        // .scene-inlinetok — 테두리 1 + 왼 2 + 그림 15 + 사이 3 + 글 + 오른 5 + 테두리 1, 바깥 여백 1씩
        g.font = `400 11px ${FONT}`;
        const pw = g.measureText(part.t).width + 27;
        if (cx + pw + 2 > w && cx > 0 && !newline()) return;
        cx += 1;
        const by = y + line * lh + (lh - 17) / 2;
        roundRect(g, x + cx, by, pw, 17, 5);
        g.fillStyle = "rgba(96,165,250,0.16)";
        g.fill();
        g.strokeStyle = "rgba(96,165,250,0.55)";
        g.lineWidth = 1;
        g.stroke();
        text(g, part.t, x + cx + 21, by + 12.5, 11, pillColor[part.kind]);
        g.font = `400 ${size}px ${FONT}`;
        cx += pw + 1;
        continue;
      }
      for (const word of part.t.split(/(\s+)/)) {
        if (!word) continue;
        const ww = g.measureText(word).width;
        if (cx + ww > w && cx > 0) {
          if (!newline()) return;
          if (/^\s+$/.test(word)) continue;
        }
        g.fillStyle = "#fff";
        g.fillText(word, x + cx, y + line * lh + lh * 0.72);
        cx += ww;
      }
    }
    if (!newline()) return;
  }
}

/** 카드 하나를 그린다 — 카드 틀(테두리·그림자)은 DOM 이 그리고, 여기는 틀 안쪽(배경·몸통)만. */
export function drawBoardItem(g: Ctx2D, item: BoardItem, imageOf: ImageOf): void {
  const { x, y, w, h } = item;
  const bw = 2; // 틀 테두리(--bw) — 안쪽은 그 안
  const ix = x + bw, iy = y + bw, iw = w - bw * 2, ih = h - bw * 2;
  g.save();
  if (item.kind === "generation" && item.dim) g.globalAlpha = 0.12;
  roundRect(g, x, y, w, h, 12);
  g.fillStyle = item.kind === "text" ? "#000" : CARD_BG;
  g.fill();
  roundRect(g, ix, iy, iw, ih, 10);
  g.clip();
  if (item.kind === "reference") {
    if (item.single) {
      const t = item.tiles[0];
      const th = iw * 0.75;
      if (t.src) image(g, imageOf(t.src), ix, iy, iw, th, item.fill, HATCH);
      else {
        hatch(g, ix, iy, iw, th, t.status === "incomplete" ? HATCH : HATCH_OFF, 4);
        text(g, t.title || "", ix + iw / 2, iy + th / 2, 13, t.status === "incomplete" ? MUTED : "#ff6b6b", 700, "center");
        text(g, t.name || "", ix + iw / 2, iy + th / 2 + 18, 10, MUTED, 400, "center");
      }
      if (t.status === "local") offMark(g, ix + iw - 27, iy + 5, 22);
    } else {
      const pad = 4, gap = 3, cols = 3;
      const cell = (iw - pad * 2 - gap * (cols - 1)) / cols;
      const maxH = Math.min(ih, 264);
      item.tiles.forEach((t, i) => {
        const cx = ix + pad + (i % cols) * (cell + gap), cy = iy + pad + Math.floor(i / cols) * (cell + gap);
        if (cy - iy > maxH) return;
        g.save();
        roundRect(g, cx, cy, cell, cell, 5);
        g.clip();
        if (t.src) image(g, imageOf(t.src), cx, cy, cell, cell, item.fill, HATCH);
        else hatch(g, cx, cy, cell, cell, t.status === "incomplete" ? HATCH : HATCH_OFF, 4);
        g.restore();
        if (t.status === "local") offMark(g, cx + cell - 19, cy + 3, 16);
      });
    }
  } else if (item.kind === "text") {
    // 글 칸은 아래 끝까지 찬다(아래 여백 24px 은 스크롤 끝의 여백일 뿐 — 넘친 줄은 카드 아래 끝에서 잘린다)
    const budget = textViewBudget(w, h);
    textBlock(g, cutTextForView(item.text, budget), ix + 8, iy + 8, iw - 16, ih - 8 + 20);
  } else if (item.kind === "model") {
    const cx = ix + iw / 2;
    if (!item.name) text(g, "모델 설정", cx, iy + ih / 2 + 4, 11, MUTED, 400, "center");
    else {
      // .scene-modelnode-body(padding 8·gap 8) — 머리(이름 12px·종류 10px) 아래 옵션 줄(위 테두리 1px·padding-top 2px·10.5px 한 줄·줄 사이 2px)
      let cy = iy + 8 + 14;
      text(g, item.name, cx, cy, 12, TEXT, 700, "center");
      if (item.type) { cy += 13; text(g, item.type.toUpperCase(), cx, cy, 10, MUTED, 400, "center"); }
      if (item.blocked) { cy += 14; text(g, "사용 불가", cx, cy, 10, "#f06a5a", 700, "center"); }
      cy += 4 + 8;
      for (const [k, v] of item.params) {
        if (cy > iy + ih) break; // 넘친 줄은 카드 아래 끝에서 잘린다(DOM 도 overflow hidden)
        g.fillStyle = "rgba(255,255,255,0.06)";
        g.fillRect(ix + 8, cy, iw - 16, 1);
        text(g, k, ix + 8, cy + 3 + 10, 10.5, MUTED);
        text(g, v, ix + iw - 8, cy + 3 + 10, 10.5, TEXT, 400, "right");
        cy += 1 + 2 + 13 + 2;
      }
    }
  } else if (item.kind === "list") {
    const px = ix + 8, py = iy + 8, pw = iw - 16, ph = ih - 16;
    if (item.mode === "label") {
      const lines = item.label.split("\n");
      lines.forEach((l, i) => text(g, l, ix + iw / 2, iy + ih / 2 + (i - (lines.length - 1) / 2) * 14 + 4, 11, MUTED, 400, "center"));
    } else if (item.mode === "thumbs") {
      const fs = Math.max(8, Math.min(30, Math.round((item.thumbPx * 8) / 42)));
      const gap = fs * 0.55 + 3, cols = Math.max(1, Math.floor((pw - fs * 0.55 + gap) / (item.thumbPx + gap)));
      const cell = (pw - fs * 0.55 - gap * (cols - 1)) / cols;
      item.tiles.forEach((t, i) => {
        const cx = px + fs * 0.55 + (i % cols) * (cell + gap), cy = py + fs * 0.55 + Math.floor(i / cols) * (cell + gap);
        if (cy > py + ph) return;
        g.save();
        roundRect(g, cx, cy, cell, cell, 4);
        g.clip();
        if (t.src) image(g, imageOf(t.src), cx, cy, cell, cell, true, HATCH);
        else hatch(g, cx, cy, cell, cell, t.status === "ok" ? HATCH : HATCH_OFF, 4);
        g.restore();
        if ((t.count ?? 0) > 1) {
          g.font = `800 ${fs}px ${FONT}`;
          const cw = g.measureText(String(t.count)).width + 6;
          g.fillStyle = "rgba(127,169,255,0.85)";
          g.fillRect(cx + cell - cw - 2, cy + cell - fs * 1.4 - 1, cw, fs * 1.4);
          text(g, String(t.count), cx + cell - 2 - cw / 2, cy + cell - fs * 0.35 - 1, fs, "#06101f", 800, "center");
        }
        if (t.mark) offMark(g, cx + cell - fs - 10, cy + 2, fs + 8);
      });
    } else {
      let cy = py;
      for (const row of item.rows) {
        if (cy + 24 > py + ph) break;
        roundRect(g, px, cy, pw, 24, 6);
        g.fillStyle = "rgba(255,255,255,0.04)";
        g.fill();
        let tx = px + 6;
        if (row.src) { image(g, imageOf(row.src), px + 6, cy + 3, 18, 18, true, HATCH); tx += 24; }
        g.save();
        g.beginPath();
        g.rect(tx, cy, px + pw - 6 - tx, 24);
        g.clip();
        text(g, row.text, tx, cy + 16, 10.5, "#cdd3dc");
        g.restore();
        cy += 27;
      }
    }
  } else if (item.kind === "generation") {
    if (item.state === "done") {
      image(g, item.src ? imageOf(item.src) : null, ix, iy, iw, ih, item.fill, HATCH_GEN);
      if (item.shared || item.final) {
        roundRect(g, ix + 5, iy + 5, 26, 26, 8);
        g.fillStyle = item.final ? "#f5c542" : item.held ? "#c9384a" : ACCENT;
        g.fill();
        text(g, item.final ? "★" : "S", ix + 18, iy + 23, item.final ? 16 : 13, item.final ? "#2a1d00" : item.held ? "#fff" : "#111", 800, "center");
      }
      if (item.draft) {
        roundRect(g, ix + iw - 58, iy + 7, 51, 22, 11);
        g.fillStyle = ACCENT;
        g.fill();
        text(g, "Draft", ix + iw - 32.5, iy + 23, 12, "#111", 800, "center");
      }
      if (item.color || item.final) {
        g.fillStyle = item.final ? "#ffcf33" : item.color!;
        g.fillRect(ix, iy + ih - 9, iw, 9);
      }
    } else if (item.state === "empty") {
      // 빈 카드 — 바탕 없이 흐린 회색 로고(.scene-genempty)
      const logo = imageOf(item.logo);
      if (logo) {
        g.globalAlpha = 0.16;
        image(g, logo, ix + iw * 0.15, iy + ih * 0.15, iw * 0.7, ih * 0.7, false, HATCH_GEN);
      }
    } else {
      hatch(g, ix, iy, iw, ih, HATCH_GEN, 8);
      if (item.state === "fail") {
        if (item.dim) g.globalAlpha = 0.12;
        text(g, item.label, ix + iw / 2, iy + ih / 2 + 4, 11.5, "#f06a5a", 700, "center");
      } else if (item.state === "deleted") {
        // 지운 그림 아이콘(ImageOffIcon) — 25% 에서는 사선 그은 사각 하나
        const s = Math.min(iw, ih) * 0.18, cx = ix + iw / 2, cy = iy + ih / 2;
        g.strokeStyle = MUTED;
        g.lineWidth = 2;
        roundRect(g, cx - s, cy - s, s * 2, s * 2, s * 0.3);
        g.stroke();
        g.beginPath();
        g.moveTo(cx - s, cy - s);
        g.lineTo(cx + s, cy + s);
        g.stroke();
      } else if (item.state === "loading") {
        const logo = imageOf(item.logo);
        const lw = Math.min(iw * 0.6, 170);
        if (logo) image(g, logo, ix + (iw - lw) / 2, iy + ih / 2 - lw / 2 - 8, lw, lw, false, HATCH_GEN);
        if (item.label) text(g, item.label, ix + iw / 2, iy + ih / 2 + lw / 2 + 6, 11.5, MUTED, 400, "center");
      }
    }
  }
  g.restore();
  if (item.kind === "generation" && item.state === "done" && item.final) {
    g.save();
    g.strokeStyle = "#ffcf33";
    g.lineWidth = 3;
    roundRect(g, x + 1.5, y + 1.5, w - 3, h - 3, 11);
    g.stroke();
    g.restore();
  }
}
