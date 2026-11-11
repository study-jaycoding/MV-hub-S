// 카드 몸통을 Canvas2D 로 그리는 순수 계산·그리기 — GPU 판(features/canvas/gpu)이 카드 그림(텍스처)을 굽는 데 쓴다
//  (docs/status/캔버스_GPU판설계_2026-11-11.md, 처음엔 25% 그림판 실험 docs/status/캔버스_보드그림판_2026-11-10.md).
//  buildBoardItem = 카드 하나를 '그릴 것'으로 바꾼다(기존 표시 계산을 그대로 부르고, 바깥 상태는 ctx 로만 받는다). null = 지원하지 않는 종류.
//  drawBoardItem = 카드 틀 안쪽(몸통)을 그린다. 틀 테두리·선택·포트·카드 밖 배지(이름표·결과 수·폴더 이름표)는 GPU 판이 따로 그린다.
import { inBoardFolder, matchesBoardFilters, type BoardFilters, type BoardFolderSelection } from "./boardFilters";
import { generationStatusLabelFor } from "./generationDisplay";
import { thumbOf } from "./media";
import { ownEntry } from "./ownEntry";
import { heldText, refHeldInfo, refServerStatus } from "./sceneAssetRelink";
import { CARD_W } from "./sceneDerive";
import { collectListInputs, collectRenderGenCardIds, effectiveTextOf } from "./sceneEdges";
import { refMediaType, refThumbSrc } from "./sceneMedia";
import { variantIds, type SceneCard, type SceneEdge } from "./scenes";
import { isDraftGeneration, normalizeSeedanceDraftParams } from "./seedanceDraft";
import { parseSceneSetTags } from "./sceneSet";
import { spotlightParamLabel, spotlightValueLabel } from "./spotlightPromptConfig";
import { TEXT_TOKEN_SRC, textTokenInfo, textViewBudget, cutTextForView, type TextTokenKind } from "./textNodeTokens";
import type { Generation } from "../types";

/** GPU 판이 그리는 종류(1단계 지원) — Comfy·View·Input·Output·Render 가 있으면 GPU 판에 들어가지 않는다(DOM 그대로). */
export const BOARD_KINDS: ReadonlySet<string> = new Set(["reference", "list", "text", "model", "generation", "head", "set"]);

type TileStatus = "ok" | "local" | "missing" | "held" | "incomplete";
type Media = "image" | "video" | "audio";
interface Tile { src: string | null; status: TileStatus; title?: string; name?: string; count?: number; mark?: boolean; media?: Media }
interface Box { id: string; x: number; y: number; w: number; h: number }
export type BoardItem = Box & (
  | { kind: "reference"; single: boolean; fill: boolean; tiles: Tile[] }
  | { kind: "text"; text: string; thumbs: Record<string, string | null> }
  | { kind: "model"; name: string | null; type: string; blocked: boolean; params: Array<[string, string, boolean]> }
  | { kind: "list"; mode: "thumbs" | "rows" | "label"; label: string; thumbPx: number; tiles: Tile[]; color: string;
      rows: Array<{ src: string | null; text: string; media?: Media; badge?: string; empty?: boolean; off?: boolean }> }
  | { kind: "generation"; state: "empty" | "blank" | "loading" | "fail" | "deleted" | "done"; label: string; src: string | null; fill: boolean;
      dim: boolean; final: boolean; shared: boolean; held: boolean; color: string | null; draft: boolean; logo: string;
      media: Media; disabled: boolean; unshared: boolean; lastViewed: boolean; sel: boolean }
  | { kind: "head"; text: string; color: string; fontSize: number }
  | { kind: "set"; project: string | null; steps: string[]; tags: string[] }
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
  /** 고른 카드인가 — 공유 안 된·비활성 결과 노드는 고르면 원래 크기·불투명이라 모습이 달라진다 */
  isSelected?: (cardId: string) => boolean;
}

const tileStatus = (workspaceId: string, ref: Parameters<typeof refServerStatus>[1]): TileStatus => refServerStatus(workspaceId, ref) ?? "ok";

/** TextCard 와 같은 계산 — 이어진 것(위→아래·왼→오른 순)의 레퍼런스 번호(@image1…) → 썸네일, 보일 글 = 자기 글이 있으면 그것, 없으면 이어 들어온 글. */
function textView(card: SceneCard, ctx: BoardBuildContext): { text: string; thumbs: Record<string, string | null> } {
  const srcs = ctx.resolvedEdges
    .filter((e) => e.to === card.id)
    .map((e) => ctx.cardsById.get(e.from))
    .filter((c): c is SceneCard => !!c)
    .sort((a, b) => (a.y !== b.y ? a.y - b.y : a.x - b.x));
  const counters: Record<string, number> = {};
  const thumbs: Record<string, string | null> = {};
  const addRef = (type: string | undefined, thumb: string | null | undefined) => {
    const t = mediaOf(type);
    counters[t] = (counters[t] || 0) + 1;
    thumbs[`@${t}${counters[t]}`] = thumb || null;
  };
  const addGenRef = (gc?: SceneCard) => {
    const gid = gc?.genId || (gc ? variantIds(gc)[0] : undefined);
    const gen = gid ? ownEntry(ctx.genData, gid) : undefined;
    addRef(gen?.assets?.[0]?.type, gen ? thumbOf(gen, 128) : null);
  };
  for (const s of srcs) {
    if (s.kind === "reference") (s.refs || []).forEach((r) => addRef(r.type, refThumbSrc(r)));
    else if (s.kind === "generation") addGenRef(s);
    else if (s.kind === "list") {
      const li = collectListInputs(s.id, ctx.cardsById, ctx.resolvedEdges);
      if (li.kind === "reference")
        for (const cid of li.referenceCardIds) {
          const item = ctx.cardsById.get(cid);
          if (item?.kind === "reference") (item.refs || []).forEach((r) => addRef(r.type, refThumbSrc(r)));
          else addGenRef(item);
        }
      else if (li.kind === "generation") for (const cid of li.generationCardIds) addGenRef(ctx.cardsById.get(cid));
    }
  }
  const own = card.text || "";
  const incoming = own.trim() ? "" : srcs.map((s) => effectiveTextOf(s.id, ctx.cardsById, ctx.resolvedEdges)).filter((t) => t.trim()).join("\n");
  return { text: own.trim() ? own : incoming, thumbs };
}
const mediaOf = (type: string | undefined): Media => (type === "video" ? "video" : type === "audio" ? "audio" : "image");

/** 카드 하나를 그릴 것으로. null = 지원하지 않는 종류(그 카드가 있으면 GPU 판에 들어가지 않는다). 그림 주소가 없으면 DOM 처럼 빗금 자리. */
export function buildBoardItem(card: SceneCard, box: Box, ctx: BoardBuildContext): BoardItem | null {
  if (card.kind === "reference") {
    const refs = card.refs || [];
    const tiles: Tile[] = [];
    for (const r of refs) {
      const media = mediaOf(refMediaType(r));
      const status = tileStatus(ctx.workspaceId, r);
      const name = r.name || r.file_path.split("|").pop()?.split("/").pop() || r.file_path;
      if (status === "missing" || status === "held" || status === "incomplete") {
        const held = status === "held" ? refHeldInfo(ctx.workspaceId, r) : undefined;
        tiles.push({ src: null, status, name, media, title: status === "missing" ? "서버에 없음" : status === "held" && held ? heldText(held).title : "확인 못 함" });
        continue;
      }
      tiles.push({ src: refThumbSrc(r) || null, status, name, media });
    }
    return { ...box, kind: "reference", single: refs.length <= 1, fill: ctx.fill, tiles };
  }
  if (card.kind === "text") return { ...box, kind: "text", ...textView(card, ctx) };
  if (card.kind === "head") return { ...box, kind: "head", text: card.text || "제목", color: card.color || "#e8c341", fontSize: card.fontSize ?? 32 };
  if (card.kind === "set") {
    // SetCard 와 같은 값 — 프로젝트 칩 + 폴더 단계 칩, 태그는 생성 카드로 실제 넘어가는 그대로(lib/sceneSet)
    const folder = card.setCfg?.folder;
    return { ...box, kind: "set", project: folder ? folder.projectName || folder.projectId : null, steps: folder ? folder.path.split("/") : [],
      tags: parseSceneSetTags(card.setCfg?.tagsText || "") };
  }
  if (card.kind === "model") {
    const cfg = card.modelCfg;
    const draft = !!cfg?.model && normalizeSeedanceDraftParams(cfg.model, cfg.params ?? {}).draft === true;
    // 셋째 값 = 그 줄에 Draft 알약(ModelCard 와 같이 resolution 줄에만)
    const params: Array<[string, string, boolean]> = cfg?.params
      ? Object.entries(cfg.params).map(([k, v]) => [spotlightParamLabel(k), spotlightValueLabel(String(v), k), k === "resolution" && draft])
      : [];
    return { ...box, kind: "model", name: cfg?.model ? cfg.modelName || cfg.model : null, type: cfg?.type || "", blocked: !!cfg?.model && ctx.modelBlocked(cfg.model), params };
  }
  if (card.kind === "list") {
    const li = collectListInputs(card.id, ctx.cardsById, ctx.resolvedEdges);
    const thumbPx = Math.max(42, Math.min(Math.round(((CARD_W * 2) / 3) * 1.5), Math.round((box.w / CARD_W) * 42)));
    const label = li.kind === "generation" ? `생성물 ${li.generationCardIds.length}개` : li.kind === "text" ? `텍스트 ${li.sourceIds.length}개`
      : li.kind === "reference" ? `레퍼런스 ${li.referenceCardIds.length}개` : li.kind === "mixed" ? "⚠ 혼합 입력(사용 불가)"
        : li.kind === "invalid" ? "⚠ 잘못된 입력" : "생성/텍스트/레퍼런스\n노드 연결";
    // 노드 자기 색(--lc) — 결과 수 배지 바탕
    const color = li.kind === "reference" ? "#7fa9ff" : li.kind === "text" ? "#b57aff" : li.kind === "empty" ? "#8a909a"
      : li.kind === "mixed" || li.kind === "invalid" ? "#ff6b6b" : ACCENT;
    const base = { ...box, kind: "list" as const, label, thumbPx, color, tiles: [] as Tile[], rows: [] as Array<{ src: string | null; text: string; media?: Media; badge?: string; empty?: boolean; off?: boolean }> };
    if (li.kind === "reference") {
      const tiles: Tile[] = [];
      for (const cid of li.referenceCardIds) {
        const rc = ctx.cardsById.get(cid);
        if (rc && rc.kind !== "reference") {
          const gid = rc.genId || variantIds(rc)[0];
          const gen = gid ? ownEntry(ctx.genData, gid) : undefined;
          const src = gen ? thumbOf(gen, 128) : null;
          tiles.push({ src, status: "ok", media: mediaOf(gen?.assets?.[0]?.type) });
          continue;
        }
        const refs = rc?.refs || [];
        const statuses = refs.map((r) => refServerStatus(ctx.workspaceId, r));
        const first = statuses[0];
        if (first === "missing" || first === "held") {
          tiles.push({ src: null, status: first, count: refs.length });
          continue;
        }
        const src = refs[0] ? refThumbSrc(refs[0]) ?? null : null;
        tiles.push({ src, status: "ok", count: refs.length, mark: statuses.some((st) => st && st !== "incomplete"), media: mediaOf(refs[0] ? refMediaType(refs[0]) : undefined) });
      }
      return { ...base, mode: "thumbs", tiles };
    }
    if (li.kind === "text") {
      const rows = li.sourceIds.map((cid) => ({ src: null, text: effectiveTextOf(cid, ctx.cardsById, ctx.resolvedEdges).trim() || "(빈 텍스트)" }));
      return { ...base, mode: "rows", rows };
    }
    if (li.kind === "generation") {
      // ListCard 의 생성물 줄 — 가운데 작은 썸네일 + 오른쪽 결과 수(▤ n, 없으면 '빈 카드'), 묶음(리스트·렌더)은 '리스트 n' 배지만
      for (const cid of li.sourceIds) {
        const gc = ctx.cardsById.get(cid);
        if (gc?.kind === "list" || gc?.kind === "render") {
          const nested = gc.kind === "list" ? collectListInputs(gc.id, ctx.cardsById, ctx.resolvedEdges) : null;
          const n = nested ? (nested.kind === "generation" ? nested.generationCardIds.length : 0) : collectRenderGenCardIds(gc.id, ctx.cardsById, ctx.resolvedEdges).length;
          base.rows.push({ src: null, text: "", badge: `${gc.kind === "render" ? "렌더" : "리스트"} ${n}` });
          continue;
        }
        const gid = gc?.genId || (gc ? variantIds(gc)[0] : undefined);
        const gen = gid ? ownEntry(ctx.genData, gid) : undefined;
        const n = gc ? variantIds(gc).length : 0;
        base.rows.push({ src: gen ? thumbOf(gen, 128) : null, text: "", media: mediaOf(gen?.assets?.[0]?.type), badge: n > 0 ? `▤ ${n}` : undefined, empty: n <= 0,
          off: !!gid && ctx.disabled(gid) });
      }
      return { ...base, mode: "rows" };
    }
    return { ...base, mode: "label" };
  }
  if (card.kind === "generation") {
    // GenerationCard 의 갈래를 같은 순서로 — 대기 → 완료(히스토리 노드) → 삭제됨 → 실패 → 답 전 → 생성 중 → 빈 카드.
    const g = card.genId ? ownEntry(ctx.genData, card.genId) : undefined;
    const base = { ...box, kind: "generation" as const, fill: ctx.fill, logo: ctx.logo, src: null, dim: false, final: false, shared: false, held: false, color: null,
      draft: false, label: "", media: "image" as Media, disabled: false, unshared: false, lastViewed: card.id === ctx.lastViewedCardId, sel: false };
    if (ctx.waiting(card.id)) return { ...base, state: "loading" };
    if (g && String(g.status) === "done") {
      const disabled = ctx.disabled(g.id);
      const unshared = !g.shared && !g.is_mine;
      return { ...base, state: "done", src: thumbOf(g) || null, final: !!g.is_final, shared: !!g.shared, held: !!g.is_held, color: g.color || null, draft: isDraftGeneration(g),
        dim: !matchesBoardFilters(g, ctx.filters) || !inBoardFolder(g, ctx.folderSel), media: mediaOf(g.assets?.[0]?.type), disabled, unshared,
        // 고름은 이 둘의 크기·투명도만 바꾼다 — 나머지 카드의 모습 열쇠에는 넣지 않는다(선택이 바뀌어도 다시 굽지 않게)
        sel: (disabled || unshared) && !!ctx.isSelected?.(card.id),
        label: thumbOf(g) ? "" : generationStatusLabelFor(String(g.status), g.error, g.execution_phase) };
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
  if (item.kind === "text") return Object.values(item.thumbs).filter((s): s is string => !!s);
  return [];
}

// ── 그리기 ────────────────────────────────────────────────────────────────────────
type Ctx2D = Pick<CanvasRenderingContext2D, "save" | "restore" | "beginPath" | "rect" | "clip" | "fill" | "stroke" | "fillRect" | "fillText" | "drawImage" |
  "measureText" | "moveTo" | "lineTo" | "arcTo" | "closePath" | "translate" | "scale"> & { fillStyle: unknown; strokeStyle: unknown; font: string; lineWidth: number; globalAlpha: number;
  textAlign: CanvasTextAlign; textBaseline: CanvasTextBaseline; filter?: string; shadowColor?: string; shadowBlur?: number; shadowOffsetY?: number };
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

/** 영상 ▶·오디오 ♪ 표시(.linb-vid·.scene-refthumb-vid) — 그림 가운데, 그림자로 어느 바탕에서도 보이게 */
function mediaMark(g: Ctx2D, media: Media | undefined, cx: number, cy: number, size: number): void {
  if (!media || media === "image") return;
  g.save();
  g.shadowColor = "rgba(0,0,0,0.65)";
  g.shadowBlur = 4;
  text(g, media === "audio" ? "♪" : "▶", cx, cy + size * 0.36, size, "#fff", 700, "center");
  g.restore();
}

/** 'Last viewed' 배지(.last-viewed-badge) — 가운데 알약 */
function lastViewedBadge(g: Ctx2D, cx: number, cy: number): void {
  g.font = `500 13px ${FONT}`;
  const w = g.measureText("Last viewed").width + 20 + 20; // 눈 아이콘 14 + 사이 6 + 좌우 여백 10씩
  roundRect(g, cx - w / 2, cy - 12, w, 24, 12);
  g.fillStyle = "rgba(8,9,12,0.34)";
  g.fill();
  g.strokeStyle = "rgba(255,255,255,0.14)";
  g.lineWidth = 1;
  g.stroke();
  g.save();
  g.shadowColor = "rgba(0,0,0,0.9)";
  g.shadowBlur = 2;
  g.strokeStyle = ACCENT;
  g.lineWidth = 1.5;
  g.beginPath();
  const ex = cx - w / 2 + 17, ey = cy;
  g.moveTo(ex - 7, ey);
  g.arcTo(ex, ey - 6, ex + 7, ey, 9);
  g.arcTo(ex, ey + 6, ex - 7, ey, 9);
  g.stroke();
  text(g, "Last viewed", cx - w / 2 + 30, cy + 4.5, 13, ACCENT, 500);
  g.restore();
}

/** 글 칸 — 줄바꿈(pre-wrap)·토큰 알약. 높이를 넘는 줄은 그리지 않는다. */
function textBlock(g: Ctx2D, raw: string, x: number, y: number, w: number, h: number, thumbs: Record<string, string | null>, imageOf: ImageOf): void {
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
    const parts: Array<{ t: string; kind?: TextTokenKind; thumb?: string | null }> = [];
    let last = 0, m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(para))) {
      if (m.index > last) parts.push({ t: para.slice(last, m.index) });
      const info = textTokenInfo(m);
      // 이어진 레퍼런스가 있는 번호만 알약(썸네일) — 없으면 그냥 글자(TextCard renderInline)
      if (info.key in thumbs) parts.push({ t: info.label, kind: info.kind, thumb: thumbs[info.key] });
      else parts.push({ t: info.label });
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
        const thumb = part.kind !== "audio" && part.thumb ? imageOf(part.thumb) : null;
        if (thumb) image(g, thumb, x + cx + 3, by + 1, 15, 15, true, HATCH);
        else if (part.kind === "audio") text(g, "🎵", x + cx + 10.5, by + 12.5, 10, "#fff", 400, "center");
        else {
          g.fillStyle = "rgba(255,255,255,0.12)";
          g.fillRect(x + cx + 3, by + 1, 15, 15);
        }
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
  if (item.kind === "head") return drawHead(g, item);
  if (item.kind === "set") return drawSet(g, item);
  if (item.kind === "generation" && item.state === "done") return drawDoneNode(g, item, imageOf);
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
      const off = t.status === "missing" || t.status === "held" || t.status === "incomplete";
      if (!off) {
        image(g, t.src ? imageOf(t.src) : null, ix, iy, iw, th, item.fill, HATCH);
        if (t.media && t.media !== "image") {
          // .scene-card-body.single .scene-refthumb-vid — 가운데 34px 원 + ▶/♪
          g.beginPath();
          g.moveTo(ix + iw / 2 + 17, iy + th / 2);
          g.arcTo(ix + iw / 2 + 17, iy + th / 2 + 17, ix + iw / 2, iy + th / 2 + 17, 17);
          g.arcTo(ix + iw / 2 - 17, iy + th / 2 + 17, ix + iw / 2 - 17, iy + th / 2, 17);
          g.arcTo(ix + iw / 2 - 17, iy + th / 2 - 17, ix + iw / 2, iy + th / 2 - 17, 17);
          g.arcTo(ix + iw / 2 + 17, iy + th / 2 - 17, ix + iw / 2 + 17, iy + th / 2, 17);
          g.fillStyle = "rgba(15,16,20,0.5)";
          g.fill();
          g.strokeStyle = "rgba(255,255,255,0.18)";
          g.lineWidth = 1;
          g.stroke();
          text(g, t.media === "audio" ? "♪" : "▶", ix + iw / 2, iy + th / 2 + 4.5, 13, "#fff", 400, "center");
        }
      } else {
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
        if (t.status === "ok" || t.status === "local") image(g, t.src ? imageOf(t.src) : null, cx, cy, cell, cell, item.fill, HATCH);
        else hatch(g, cx, cy, cell, cell, t.status === "incomplete" ? HATCH : HATCH_OFF, 4);
        g.restore();
        if (t.media && t.media !== "image" && (t.status === "ok" || t.status === "local")) {
          // .scene-refthumb-vid — 오른쪽 아래 작은 검은 칩
          g.fillStyle = "rgba(0,0,0,0.55)";
          g.fillRect(cx + cell - 14, cy + cell - 13, 12, 12);
          text(g, t.media === "audio" ? "♪" : "▶", cx + cell - 8, cy + cell - 4, 8, "#fff", 400, "center");
        }
        if (t.status === "local") offMark(g, cx + cell - 19, cy + 3, 16);
      });
    }
  } else if (item.kind === "text") {
    // 글 칸은 아래 끝까지 찬다(아래 여백 24px 은 스크롤 끝의 여백일 뿐 — 넘친 줄은 카드 아래 끝에서 잘린다)
    if (!item.text) text(g, "텍스트 입력", ix + 8, iy + 8 + 15, 12, MUTED); // .scene-textnode-ph2
    else textBlock(g, cutTextForView(item.text, textViewBudget(w, h)), ix + 8, iy + 8, iw - 16, ih - 8 + 20, item.thumbs, imageOf);
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
      for (const [k, v, draft] of item.params) {
        if (cy > iy + ih) break; // 넘친 줄은 카드 아래 끝에서 잘린다(DOM 도 overflow hidden)
        g.fillStyle = "rgba(255,255,255,0.06)";
        g.fillRect(ix + 8, cy, iw - 16, 1);
        text(g, k, ix + 8, cy + 3 + 10, 10.5, MUTED);
        let vx = ix + iw - 8;
        if (draft) {
          // .scene-modelnode-draft — 값 오른쪽의 라임 알약
          g.font = `800 9px ${FONT}`;
          const dw = g.measureText("Draft").width + 10;
          roundRect(g, vx - dw, cy + 3, dw, 13, 6.5);
          g.fillStyle = ACCENT;
          g.fill();
          text(g, "Draft", vx - dw / 2, cy + 3 + 9.5, 9, "#111", 800, "center");
          vx -= dw + 4;
        }
        text(g, v, vx, cy + 3 + 10, 10.5, TEXT, 400, "right");
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
        mediaMark(g, t.media, cx + cell / 2, cy + cell / 2, Math.min(18, cell * 0.4));
        if ((t.count ?? 0) > 1) {
          g.font = `800 ${fs}px ${FONT}`;
          const cw = g.measureText(String(t.count)).width + 6;
          g.fillStyle = "rgba(127,169,255,0.85)";
          g.fillRect(cx + cell - cw - 2, cy + cell - fs * 1.4 - 1, cw, fs * 1.4);
          text(g, String(t.count), cx + cell - 2 - cw / 2, cy + cell - fs * 0.35 - 1, fs, "#06101f", 800, "center");
        }
        if (t.mark) offMark(g, cx + cell - fs - 10, cy + 2, fs + 8);
        // .scene-listthumb-n — 칸 왼쪽 위 밖으로 걸친 번호 알약(이미지 파랑·영상 라임·오디오 보라)
        const n = String(i + 1);
        g.font = `900 ${fs}px ${FONT}`;
        const nw = Math.max(fs * 1.7, g.measureText(n).width + fs);
        roundRect(g, cx - fs * 0.55, cy - fs * 0.55, nw, fs * 1.7, fs * 0.85);
        g.fillStyle = t.media === "video" ? ACCENT : t.media === "audio" ? "#725ac0" : "#3d5afe";
        g.fill();
        text(g, n, cx - fs * 0.55 + nw / 2, cy - fs * 0.55 + fs * 1.22, fs, t.media === "video" ? "#111" : "#fff", 900, "center");
      });
    } else {
      // .scene-listrow — 24px 줄(3px 간격·위아래 3px 여백·테두리 1px)
      let cy = py;
      for (const row of item.rows) {
        if (cy > py + ph) break; // 넘친 줄은 카드 안 스크롤 몫(DOM 도 overflow hidden)
        g.save();
        if (row.off) g.globalAlpha = 0.5;
        roundRect(g, px, cy, pw, 30, 6);
        g.fillStyle = "rgba(255,255,255,0.04)";
        g.fill();
        g.strokeStyle = "rgba(255,255,255,0.08)";
        g.lineWidth = 1;
        g.stroke();
        if (row.text) {
          g.save();
          g.beginPath();
          g.rect(px + 6, cy, pw - 12, 30);
          g.clip();
          text(g, row.text, px + 6, cy + 19, 10.5, "#cdd3dc");
          g.restore();
        } else {
          let bx = px + pw - 6;
          if (row.badge) {
            g.font = `800 11px ${FONT}`;
            const bw = g.measureText(row.badge).width + 16;
            roundRect(g, bx - bw, cy + 5, bw, 20, 8);
            g.fillStyle = item.color;
            g.fill();
            text(g, row.badge, bx - bw / 2, cy + 19, 11, "#111", 800, "center");
            bx -= bw;
          } else if (row.empty) {
            g.font = `400 10.5px ${FONT}`;
            const ew = g.measureText("빈 카드").width;
            text(g, "빈 카드", bx - ew, cy + 19, 10.5, MUTED);
            bx -= ew;
          }
          if (row.badge?.startsWith("▤") || row.empty) {
            // 가운데 썸네일(남는 폭의 가운데 — margin-left:auto 두 개)
            const tx = px + 6 + (bx - (px + 6) - 24) / 2;
            if (row.off) g.filter = "grayscale(1)";
            image(g, row.src ? imageOf(row.src) : null, tx, cy + 3, 24, 24, true, HATCH);
            g.filter = "none";
            mediaMark(g, row.media, tx + 12, cy + 15, 10);
          }
        }
        g.restore();
        cy += 33;
      }
    }
  } else if (item.kind === "generation") {
    if (item.state === "empty") {
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
    if (item.lastViewed) lastViewedBadge(g, ix + iw / 2, iy + ih / 2);
  }
  g.restore();
}

/** 완료 결과 = 히스토리 노드(.linb-node) — 카드 틀은 투명하고(.scene-card.has-node) 노드가 카드를 채운다.
 *  공유 안 된 남의 것(0.9배·반투명)·비활성(0.7배·흑백 어둡게·빗금)은 고르지 않았을 때만 줄인다(history.css). */
function drawDoneNode(g: Ctx2D, item: Extract<BoardItem, { kind: "generation" }>, imageOf: ImageOf): void {
  const s = item.sel ? 1 : item.disabled ? 0.7 : item.unshared ? 0.9 : 1;
  const w = item.w * s, h = item.h * s;
  const x = item.x + (item.w - w) / 2, y = item.y + (item.h - h) / 2;
  g.save();
  g.globalAlpha = item.dim ? 0.12 : item.unshared && !item.sel ? 0.5 : 1;
  roundRect(g, x, y, w, h, 12);
  g.fillStyle = item.fill ? CARD_BG : "#050608";
  g.fill();
  roundRect(g, x + 2, y + 2, w - 4, h - 4, 10);
  g.clip();
  const ix = x + 2, iy = y + 2, iw = w - 4, ih = h - 4;
  if (item.disabled) g.filter = "grayscale(1) brightness(0.5)";
  const img = item.src ? imageOf(item.src) : null;
  if (img) image(g, img, ix, iy, iw, ih, item.fill, HATCH_GEN);
  else {
    hatch(g, ix, iy, iw, ih, HATCH_GEN, 8);
    if (item.label) text(g, item.label, ix + iw / 2, iy + ih / 2 + 4, 11.5, MUTED, 400, "center"); // .linb-ph 상태 글
  }
  if (item.disabled) {
    g.filter = "none";
    // .linb-node.disabled::after — 굵은 빗금
    g.strokeStyle = "rgba(0,0,0,0.55)";
    g.lineWidth = 4;
    g.beginPath();
    for (let d = -ih; d < iw + ih; d += 14) {
      g.moveTo(ix + d, iy);
      g.lineTo(ix + d + ih, iy + ih);
    }
    g.stroke();
  }
  if (!item.lastViewed) mediaMark(g, item.media, ix + iw / 2, iy + ih / 2, 24);
  if (item.shared || item.final) {
    roundRect(g, ix + 5, iy + 5, 26, 26, 8);
    g.fillStyle = item.final ? "#f5c542" : item.held ? "#c9384a" : ACCENT;
    g.fill();
    text(g, item.final ? "★" : "S", ix + 18, iy + 23, item.final ? 16 : 13, item.final ? "#2a1d00" : item.held ? "#fff" : "#111", 800, "center");
  }
  if (item.draft && !item.sel) {
    // 고른 노드에서는 Draft 알약을 숨긴다(history.css .scene-card.sel .linb-draft)
    roundRect(g, ix + iw - 58, iy + 7, 51, 22, 11);
    g.fillStyle = ACCENT;
    g.fill();
    text(g, "Draft", ix + iw - 32.5, iy + 23, 12, "#111", 800, "center");
  }
  if (item.color || item.final) {
    g.fillStyle = item.final ? "#ffcf33" : item.color!;
    g.fillRect(ix, iy + ih - 9, iw, 9);
  }
  if (item.lastViewed) lastViewedBadge(g, ix + iw / 2, iy + ih / 2);
  g.restore();
  if (item.final) {
    g.save();
    g.globalAlpha = item.dim ? 0.12 : 1;
    g.strokeStyle = "#ffcf33";
    g.lineWidth = 3;
    roundRect(g, x + 1.5, y + 1.5, w - 3, h - 3, 11);
    g.stroke();
    g.restore();
  }
}

const SET_PC = "#e8c341";
/** 세트(set) — 금색 물든 몸통 + 맨 위 금색 'SET' 막대 + 폴더(프로젝트 칩·단계 칩)·태그 칩(.scene-card-set·.scene-setnode-*). 넘치면 칩은 줄을 바꾸고
 *  카드 아래 끝에서 잘린다(DOM 도 몸통이 overflow hidden). */
function drawSet(g: Ctx2D, item: Extract<BoardItem, { kind: "set" }>): void {
  const { x, y, w, h } = item;
  g.save();
  roundRect(g, x, y, w, h, 14);
  g.fillStyle = "#2d2818"; // color-mix(#e8c341 15%, #0c0d11)
  g.fill();
  roundRect(g, x + 2, y + 2, w - 4, h - 4, 12);
  g.clip();
  const ix = x + 2, iw = w - 4;
  g.fillStyle = SET_PC;
  g.fillRect(ix, y + 2, iw, 19);
  g.font = `900 11px ${FONT}`;
  g.fillStyle = "#06101f";
  g.textAlign = "left";
  g.textBaseline = "alphabetic";
  let lx = ix + 7;
  for (const ch of "SET") {
    g.fillText(ch, lx, y + 2 + 14);
    lx += g.measureText(ch).width + 1.1; // letter-spacing 0.1em
  }
  const px = ix + 9, pw = iw - 18;
  let cy = y + 2 + 19 + 8;
  const label = (s: string) => {
    text(g, s, px, cy + 8, 9, "#d1ba56", 800);
    cy += 9 * 1.2 + 3;
  };
  /** 칩 줄 — 넘치면 다음 줄(4px·3px 간격) */
  const chips = (items: Array<{ s: string; hash?: boolean; sep?: boolean }>, gap: number) => {
    let cx = px;
    for (const it of items) {
      g.font = `700 11px ${FONT}`;
      const tw = g.measureText(it.s).width + (it.hash ? g.measureText("#").width + 1 : 0) + 16;
      const sepW = it.sep ? 10 : 0;
      if (cx + sepW + tw > px + pw && cx > px) {
        cx = px;
        cy += 20 + gap;
      }
      if (it.sep) {
        text(g, "›", cx + 2, cy + 14, 10, MUTED, 700);
        cx += sepW;
      }
      roundRect(g, cx, cy, Math.min(tw, pw), 20, 8);
      g.fillStyle = "rgba(232,195,65,0.22)";
      g.fill();
      g.strokeStyle = SET_PC;
      g.lineWidth = 1;
      g.stroke();
      let tx = cx + 8;
      if (it.hash) {
        text(g, "#", tx, cy + 14, 11, "#f4dd8a", 700);
        tx += g.measureText("#").width + 1;
      }
      text(g, it.s, tx, cy + 14, 11, TEXT, 700);
      cx += Math.min(tw, pw) + gap;
    }
    cy += 20;
  };
  const placeholder = (icon: string, s: string) => {
    roundRect(g, px, cy, pw, 24, 8);
    g.save();
    g.strokeStyle = "rgba(232,195,65,0.55)";
    g.lineWidth = 1;
    g.stroke();
    g.restore();
    text(g, icon, px + 10 + 7, cy + 16, 11, MUTED, 600, "center");
    text(g, s, px + 10 + 14 + 5, cy + 16, 11, MUTED, 600);
    cy += 24;
  };
  label("폴더");
  if (item.project) {
    roundRect(g, px, cy, pw, 28, 8);
    g.fillStyle = SET_PC;
    g.fill();
    text(g, "📁", px + 8 + 7, cy + 18, 12, "#06101f", 800, "center");
    g.save();
    g.beginPath();
    g.rect(px + 8 + 14 + 5, cy, pw - 8 - 14 - 5 - 20, 28);
    g.clip();
    text(g, item.project, px + 8 + 14 + 5, cy + 18.5, 12.5, "#06101f", 800);
    g.restore();
    text(g, "×", px + pw - 12, cy + 18, 12, "#4a3d10", 400, "center");
    cy += 28 + 5;
    chips(item.steps.map((s, i) => ({ s, sep: i > 0 })), 3);
  } else placeholder("📁", "폴더 끌어 놓기");
  cy += 7;
  label("태그");
  if (item.tags.length) chips(item.tags.map((s) => ({ s, hash: true })), 4);
  else placeholder("#", "태그1, 태그2");
  g.restore();
}

/** 제목(head) — 틀·바탕 없는 굵은 글씨(.scene-headnode-text: 2px 6px 여백·900·줄높이 1.2·줄바꿈 보존·그림자) */
function drawHead(g: Ctx2D, item: Extract<BoardItem, { kind: "head" }>): void {
  g.save();
  g.shadowColor = "rgba(0,0,0,0.5)";
  g.shadowBlur = 10;
  g.shadowOffsetY = 2;
  const lh = item.fontSize * 1.2;
  item.text.split("\n").forEach((line, i) => {
    // 줄 상자(1.2em) 안의 글자 기준선 ≈ 위에서 0.1em(반 여백) + 0.9em(올림)
    text(g, line, item.x + 6, item.y + 2 + i * lh + item.fontSize * 1.0, item.fontSize, item.color, 900);
  });
  g.restore();
}
