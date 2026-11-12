// MV Agent 화면 동작 실행기(docs/status/MVAgent_화면동작_2026-11-12.md 3-2·3-3·3-3b) — 허브가 발급하고 이 칸이 claim 한 동작만
//  여기서 실행한다. 이름 → 처리 함수 표(표에 없는 이름은 거절). 실행 전후를 비교해 실제로 바뀐 것만 보고하고, 되돌리기 자료를 함께 준다.
//  허브는 캔버스·회색 상태를 모른다 — 씬 내용은 이 창의 보드(screenRef)에서만 본다.
import type { CanvasInputCommand } from "../features/canvas/api";
import { disabledGenRev, disabledGenStamp, loadDisabledGen, setDisabledGen } from "./deactivated";
import { uid, type SceneCard, type SceneEdge, type SceneGroup } from "./scenes";

/** 보드의 지금 문서(캔버스 편집의 스냅샷과 같은 모양 — 기능 내부 타입 대신 씬 타입으로 적는다). */
export interface ScreenSnapshot { cards: SceneCard[]; edges: SceneEdge[]; groups: SceneGroup[] }

/** 이 창에 붙은 캔버스 보드의 손잡이 — SceneBoard 가 그 씬을 보는 동안만 채운다(App 이 칸에 넘김). */
export interface SceneScreenHandle {
  sceneId: string;
  commit: (command: CanvasInputCommand) => boolean;
  snapshot: () => ScreenSnapshot;
  viewCenter: () => { x: number; y: number };
  canEdit: () => boolean; // 보기 모드(GPU 판)·씬 전환 중이면 거짓 — '바뀐 것 없음'과 '거절'을 가른다
  selectCards: (ids: string[]) => void;
  selectedCardIds: () => string[];
}
export interface ScreenHost { scene: () => SceneScreenHandle | null }

export type ScreenUndo =
  | { kind: "canvas"; sceneId: string; cardIds: string[]; edgeIds: string[]; fingerprint: string }
  | { kind: "hidden"; ids: string[]; hidden: boolean; rev: number; stored: string; stamp: string };
export interface ScreenReceipt {
  ok: boolean;
  summary: string;
  data: Record<string, unknown>;
  undo?: ScreenUndo;
}

const CARD_STEP = 220; // 만든 노드를 화면 가운데부터 옆으로 — 생성 카드 기본 폭(180) + 틈
const LABEL_MAX = 40;

/** 씬 지문 — 카드·엣지·그룹의 **내용**(객체 참조가 아님). 사람이 무엇을 바꿨든 다르면 되돌리지 않는다. */
export function sceneFingerprint(snapshot: ScreenSnapshot): string {
  const text = JSON.stringify([snapshot.cards, snapshot.edges, snapshot.groups]);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619) >>> 0;
  return `${text.length}:${hash.toString(16)}`;
}

const storedHidden = () => JSON.stringify([...loadDisabledGen()].sort());
const fail = (summary: string): ScreenReceipt => ({ ok: false, summary, data: {} });

function board(host: ScreenHost, sceneId: unknown, edit: boolean): SceneScreenHandle | ScreenReceipt {
  const scene = host.scene();
  if (!scene || typeof sceneId !== "string" || scene.sceneId !== sceneId) return fail("그 씬을 이 창의 캔버스에서 열어 주세요");
  if (edit && !scene.canEdit()) return fail("보기 모드라 바꿀 수 없어요");
  return scene;
}
const isReceipt = (value: SceneScreenHandle | ScreenReceipt): value is ScreenReceipt => "ok" in value;

type Handler = (args: Record<string, unknown>, host: ScreenHost) => ScreenReceipt;

const HANDLERS: Record<string, Handler> = {
  "canvas.read_selection": (args, host) => {
    const scene = board(host, args.scene_id, false);
    if (isReceipt(scene)) return scene;
    const byId = new Map(scene.snapshot().cards.map((card) => [card.id, card]));
    const cards = scene.selectedCardIds().flatMap((id) => {
      const card = byId.get(id);
      if (!card) return [];
      const label = (card.text || card.prompt || "").replace(/\s+/g, " ").trim().slice(0, LABEL_MAX);
      return [{ id: card.id, kind: card.kind, label }];
    }).slice(0, 20);
    return { ok: true, summary: cards.length ? `고른 카드 ${cards.length}개` : "고른 카드가 없어요", data: { cards } };
  },
  "canvas.create_nodes": (args, host) => {
    const scene = board(host, args.scene_id, true);
    if (isReceipt(scene)) return scene;
    const nodes = Array.isArray(args.nodes) ? args.nodes.slice(0, 5) : [];
    const center = scene.viewCenter();
    const asked: string[] = [];
    nodes.forEach((node, index) => {
      const item = node as { kind?: unknown; text?: unknown };
      if (item.kind !== "generation" && item.kind !== "text") return;
      const id = uid();
      const text = item.kind === "text" && typeof item.text === "string" ? item.text.slice(0, 2000) : undefined;
      const position = { x: Math.round(center.x - 90 + index * CARD_STEP), y: Math.round(center.y - 75) };
      if (scene.commit({ type: "createNode", id, kind: item.kind, position, ...(text !== undefined ? { text } : {}) })) asked.push(id);
    });
    const after = scene.snapshot();
    const present = new Set(after.cards.map((card) => card.id));
    const made = asked.filter((id) => present.has(id)); // 명령이 참이어도 실제로 생긴 것만
    if (!made.length) return fail("새 노드를 만들지 못했어요");
    scene.selectCards(made); // 사람이 만들 때처럼 골라 둔다 — 어디 생겼는지 찾게
    return {
      ok: true, summary: `새 노드 ${made.length}개 만듦`, data: { card_ids: made },
      undo: { kind: "canvas", sceneId: scene.sceneId, cardIds: made, edgeIds: [], fingerprint: sceneFingerprint(after) },
    };
  },
  "canvas.connect": (args, host) => {
    const scene = board(host, args.scene_id, true);
    if (isReceipt(scene)) return scene;
    const pairs = (Array.isArray(args.pairs) ? args.pairs : []).slice(0, 10)
      .filter((pair): pair is [string, string] => Array.isArray(pair) && pair.length === 2 && pair.every((id) => typeof id === "string"));
    const before = new Set(scene.snapshot().edges.map((edge) => edge.id));
    if (pairs.length) scene.commit({ type: "connectCards", pairs });
    const after = scene.snapshot();
    const added = after.edges.filter((edge) => !before.has(edge.id));
    const joined = new Set(added.map((edge) => `${edge.from}>${edge.to}`));
    const skipped = pairs.filter(([from, to]) => !joined.has(`${from}>${to}`));
    if (!added.length) return { ok: false, summary: "이을 수 있는 쌍이 없었어요", data: { skipped } };
    return {
      ok: true, summary: `${added.length}개 이음${skipped.length ? ` · ${skipped.length}개 건너뜀` : ""}`,
      data: { edge_ids: added.map((edge) => edge.id), skipped },
      undo: { kind: "canvas", sceneId: scene.sceneId, cardIds: [], edgeIds: added.map((edge) => edge.id), fingerprint: sceneFingerprint(after) },
    };
  },
  "library.set_hidden": (args) => {
    const ids = (Array.isArray(args.generation_ids) ? args.generation_ids : []).filter((id): id is string => typeof id === "string").slice(0, 50);
    const hidden = args.hidden === true;
    const before = loadDisabledGen();
    if (!ids.some((id) => before.has(id) !== hidden)) return { ok: true, summary: `바뀐 생성물이 없어요 · 이 브라우저 기준`, data: { changed: [] } };
    const { stamp } = setDisabledGen(ids, hidden);
    const after = loadDisabledGen(); // 다시 읽어 실제로 바뀐 것만(저장 결과와 별개로 지금 값으로 센다)
    const changed = ids.filter((id) => before.has(id) !== after.has(id) && after.has(id) === hidden);
    const word = hidden ? "회색(비활성)으로 바꿈" : "회색(비활성)을 풂";
    if (!changed.length) return { ok: false, summary: "회색 표시를 바꾸지 못했어요 — 저장이 안 됐어요", data: { changed: [] } };
    // 되돌리기 기준 — 이번에 쓴 표식이 비어 있지 않고 지금도 그 표식일 때만(빈 표식은 변경을 구별 못 함, 독립 리뷰 3차 P1)
    const undo: ScreenUndo | undefined = stamp && disabledGenStamp() === stamp
      ? { kind: "hidden", ids: changed, hidden, rev: disabledGenRev(), stored: storedHidden(), stamp } : undefined;
    return { ok: true, summary: `생성물 ${changed.length}개 ${word} · 이 브라우저 기준`, data: { changed }, ...(undo ? { undo } : {}) };
  },
};

export const SCREEN_ACTION_NAMES = Object.keys(HANDLERS);

export function runScreenAction(name: string, args: unknown, host: ScreenHost): ScreenReceipt {
  const handler = HANDLERS[name];
  if (!handler) return fail("모르는 화면 동작이에요");
  try {
    return handler(args && typeof args === "object" ? args as Record<string, unknown> : {}, host);
  } catch {
    return fail("화면 동작을 하지 못했어요");
  }
}

/** 되돌리기 — 그 동작이 바꾼 것만, 뒤에 손댄 것이 없을 때만. later = 같은 칸에서 이 동작 뒤에 한 동작들의 직후 지문. */
export function undoScreenAction(undo: ScreenUndo, host: ScreenHost, later: string[] = []): { ok: boolean; message: string; undo?: ScreenUndo } {
  if (undo.kind === "hidden") {
    // 바뀜 번호(이 창 저장·다른 창 알림)·저장된 값·저장마다 새로 적는 표식을 함께 본다 — 다른 창이 풀었다 다시 회색으로 해
    //  값이 같아지고 알림이 늦어도 표식이 다르면 되돌리지 않는다(독립 리뷰 P1)
    if (!undo.stamp || disabledGenRev() !== undo.rev || storedHidden() !== undo.stored || disabledGenStamp() !== undo.stamp) {
      return { ok: false, message: "그 뒤 회색 표시가 바뀌어 되돌릴 수 없어요" };
    }
    const before = storedHidden();
    const { saved, stamp } = setDisabledGen(undo.ids, !undo.hidden);
    const now = loadDisabledGen(); // 다시 읽어 실제로 되돌려졌을 때만 성공
    if (saved && undo.ids.every((id) => now.has(id) !== undo.hidden)) return { ok: true, message: "되돌렸어요" };
    // 기준을 다시 잡는 것은 **내 저장 실패가 확인되고**(saved=false) 그 사이 다른 창의 변경이 없을 때만 — 값은 그대로,
    //  표식은 방금 내가 쓴 것(비어 있지 않음). 아니면 다른 창의 변경을 기준으로 받아들이지 않는다(독립 리뷰 3차 P1)
    if (!saved && stamp && storedHidden() === before && disabledGenStamp() === stamp) {
      return { ok: false, message: "되돌리지 못했어요 — 저장이 안 됐어요", undo: { ...undo, rev: disabledGenRev(), stored: before, stamp } };
    }
    return { ok: false, message: "그 뒤 회색 표시가 바뀌어 되돌릴 수 없어요" };
  }
  const scene = host.scene();
  if (!scene || scene.sceneId !== undo.sceneId) return { ok: false, message: "그 씬을 이 창의 캔버스에서 열어 주세요" };
  if (!scene.canEdit()) return { ok: false, message: "보기 모드라 바꿀 수 없어요" };
  const now = sceneFingerprint(scene.snapshot()); // 확인과 명령 사이에 다른 편집이 끼지 않게 한 처리 안에서
  if (now !== undo.fingerprint) {
    return later.includes(now) ? { ok: false, message: "아래 카드부터 되돌려 주세요" }
      : { ok: false, message: "그 뒤 캔버스가 바뀌어 되돌릴 수 없어요 — Ctrl+Z 를 쓰세요" };
  }
  if (undo.edgeIds.length) scene.commit({ type: "disconnectEdges", edgeIds: undo.edgeIds });
  if (undo.cardIds.length) scene.commit({ type: "removeCards", cardIds: undo.cardIds });
  // 명령의 참/거짓이 아니라 문서를 다시 보고 정한다 — 남아 있으면 단추를 남긴다(독립 리뷰 P2)
  const after = scene.snapshot();
  const cards = new Set(after.cards.map((card) => card.id));
  const edges = new Set(after.edges.map((edge) => edge.id));
  return undo.cardIds.some((id) => cards.has(id)) || undo.edgeIds.some((id) => edges.has(id))
    ? { ok: false, message: "되돌리지 못했어요 — 캔버스가 받아들이지 않았어요" } : { ok: true, message: "되돌렸어요" };
}
