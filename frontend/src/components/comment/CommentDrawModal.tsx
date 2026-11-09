// 코멘트 그림 창 — 그림을 그려 코멘트에 붙인다. 생성물·어셋 공용(설계 docs/status/크게보기_코멘트그림_설계_2026-11-05.md §10 C1·C6,
//  docs/status/어셋코멘트그림_설계_2026-11-05.md §4·§6 — Jay 11-09 시안 ⑥ 영상·⑦ 이미지 확정).
//  왼쪽 = 무대 + 그 아래 한 판(영상: 타임라인 → 재생 줄 → 도구 줄 · 이미지: 그림 ①②③ 번호 줄 → 도구 줄).
//  오른쪽 = 작은 코멘트 창 그대로(목록 · 한 줄 입력 · [전송] · 비공개 쓰기/읽기) — 새 코멘트를 보내면 그린 그림이 그 코멘트에 붙는다.
//  영상은 프레임마다 그린다 — 그린 프레임 = 타임라인의 채운 동그라미, 지난 코멘트 그림이 있는 프레임 = 빈 동그라미.
//  그림의 기준 시각은 그 프레임에 처음 그릴 때의 video.currentTime 으로 고정한다(C6). 그림이 있을 때만 comments-v2, 글만이면 옛 경로.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api";
import { captureOperationContext, isOperationContextCurrent } from "../../app/operationContext";
import { getAccountNamespace } from "../../lib/accountScope";
import { expectationFor, type CommentWriteContext } from "../../lib/commentTarget";
import { EDIT_FPS, timecode } from "../../lib/editTimeline";
import { flashMsg } from "../../lib/flash";
import { API_PAUSED_MESSAGE, ApiPausedError, HttpError, errorDetail } from "../../lib/http";
import { useModalFocus } from "../../lib/keyGate";
import { videoFramePng } from "../../lib/mediaCapture";
import { holdUnload } from "../../lib/unloadGuard";
import { useEscapeClose } from "../../lib/useEscapeClose";
import type { AssetComment, CommentDrawingIn, CommentDrawingMeta, CommentDrawingView, CommentTarget, GenComment } from "../../types";
import { CommentPanel, type CommentComposer } from "../common/CommentPanel";
import { HostConfirm } from "../common/HostConfirm";
import { CloseIcon } from "../common/ViewIcons";
import { DrawDock, DrawTextInput, TOOL_ICONS } from "../edit/drawing/DrawDock";
import { drawingHash, MAX_DRAWINGS, StrokesTooLarge, toStrokesV1, type DrawItem } from "../edit/drawing/strokes";
import { useDrawingInput } from "../edit/drawing/useDrawingInput";
import { CommentDrawingStrip, GenCommentPanel, StrokesCanvas, UNSUPPORTED_DRAWING, secLabel, useCommentDrawing } from "../GenCommentPanel";

const MAX_WORK_PIXELS = 12_000_000; // 그리는 캔버스만 줄인다 — 좌표계는 원본 크기(C4)
const THUMB_SIDE = 320; // 영상 그림의 목록용 미리보기 긴 변(설계 §3.2)
const THUMB_MAX_BYTES = 64 * 1024;
const PRIV_KEY = "ch.cmt.private"; // 코멘트 창과 같은 '다음 코멘트를 비공개로' 설정
const NO_WORKSPACE = { scope: "unknown" as const, id: null, name: null };

function workSize(w: number, h: number) {
  const k = Math.min(1, Math.sqrt(MAX_WORK_PIXELS / (w * h)));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}
const frameOf = (time: number) => Math.round(time * EDIT_FPS);
const circled = (n: number) => (n >= 1 && n <= 20 ? String.fromCharCode(0x245f + n) : String(n));

// 안전하지 않은 주소(LAN http)에서는 crypto.randomUUID 가 없다 — getRandomValues 로 v4 를 만든다
function uuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

interface Thumb { b64: string; bytes: Uint8Array<ArrayBuffer>; url: string }
// 그림 한 장 — 이미지는 캡쳐한 판마다(key = 판 번호), 영상은 그린 프레임마다 하나.
//  captured = 이미지에서 붙은 장(캡쳐했거나 다른 판으로 넘어감) — 번호 줄의 빈 번호·빨간 숫자. 보낼 때는 캡쳐 안 한 판도 함께 간다.
interface Sheet {
  id: string; key: number; timeSec: number | null; items: DrawItem[]; thumb: Thumb | null; thumbJob: Promise<void> | null; captured: boolean;
}

/** 지금 장면의 작은 JPEG — 다른 출처 영상은 lib/mediaCapture 가 CORS 사본으로 뜬다. 실패하면 null(thumb 없이 획만 — 정상 계약 C6). */
async function frameThumb(video: HTMLVideoElement): Promise<Thumb | null> {
  try {
    const bitmap = await createImageBitmap(await videoFramePng(video));
    const k = Math.min(1, THUMB_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * k));
    canvas.height = Math.max(1, Math.round(bitmap.height * k));
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    for (const quality of [0.7, 0.5, 0.35]) {
      const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, "image/jpeg", quality));
      if (blob && blob.size <= THUMB_MAX_BYTES) {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        return { b64: toBase64(bytes), bytes, url: URL.createObjectURL(blob) };
      }
    }
  } catch {
    /* 다른 출처·디코딩 실패 — thumb 없이 */
  }
  return null;
}

/** 지난 코멘트의 그림을 무대 위에 겹쳐 본다(읽기 전용) — 그 그림의 대상 경로로 받는다. */
function ViewingLayer({ view, onGone }: { view: CommentDrawingView; onGone: () => void }) {
  const state = useCommentDrawing(view.target, view.commentId, view.drawing);
  useEffect(() => {
    if (state.status === "gone") onGone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status]);
  if (state.status === "unsupported") return <div className="cm-view-note">{UNSUPPORTED_DRAWING}</div>;
  if (state.status !== "ok") return null;
  return <StrokesCanvas className="cm-view-layer" items={state.items} width={view.drawing.width} height={view.drawing.height} maxPx={2048} />;
}

/** 어셋 코멘트의 목록·답글·수정·삭제·새로 읽기 — 지금 담당(useAssetCommentActions)이 쥔다. 그림 창은 새 코멘트(+그림)만 보낸다. */
export interface AssetCommentSide {
  comments: AssetComment[];
  onSend: (text: string, parentId: string | null | undefined, isPrivate: boolean) => Promise<boolean>;
  onEdit: (id: string, text: string) => Promise<boolean>;
  onDelete: (id: string) => void;
  refresh: () => void;
}

// 보낸 결과의 안내(설계 §4 초안 규칙) — 보내지 않음 · 결과 모름 · 이 PC 에만 저장 등. 저장 확인은 안내 없이 초안을 비운다.
interface Notice { text: string; renew?: string } // renew = 새 코멘트(새 id)로 보내는 단추의 글자

interface Props {
  target: CommentTarget;
  type: "image" | "video";
  url: string;
  thumb?: string | null;
  name: string;
  myId: string;
  startTime?: number; // 영상 — 크게 보기에서 보던 시각
  // 비공개로 쓸 수 있나 — 서버 직결 화면은 서버가 비공개를 받지 않는다: 새 글·답글 모두 공개로 보낸다
  allowPrivate?: boolean;
  initialText?: string; // 작은 창의 [편집] 으로 넘겨받은 쓰던 글
  assetSide?: AssetCommentSide; // 어셋 대상의 오른쪽 칸
  writeContext?: CommentWriteContext | null; // 어셋 comments-v2 의 기대값 — 없으면 준비 안 됨(전송을 막는다)
  onClose: () => void;
  onSaved: () => void; // 코멘트를 달았다(목록·C 단추 상태를 다시 읽는다)
}

export function CommentDrawModal({
  target, type, url, thumb, name, myId, startTime = 0, allowPrivate = true, initialText = "", assetSide, writeContext, onClose, onSaved,
}: Props) {
  const isVideo = type === "video";
  const isAsset = target.kind === "asset";
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const work = useMemo(() => (natural ? workSize(natural.w, natural.h) : null), [natural]);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [time, setTime] = useState(startTime);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [text, setText] = useState(initialText);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [privateChoice, setPrivateChoice] = useState(() => {
    try {
      return localStorage.getItem(PRIV_KEY) === "1";
    } catch {
      return false;
    }
  });
  const writePrivate = allowPrivate && privateChoice;
  const [viewing, setViewing] = useState<CommentDrawingView | null>(null);
  const pendingViewRef = useRef<CommentDrawingView | null>(null);
  const [sideTick, setSideTick] = useState(0);
  const [sideUnsent, setSideUnsent] = useState(false); // 오른쪽의 보내지 않은 답글·수정
  const [genComments, setGenComments] = useState<GenComment[]>([]);
  const onGenComments = useCallback((list: GenComment[]) => setGenComments(list), []);
  // 재시도 id — 같은 작성 의도를 다시 보낼 때 같은 id(답을 못 받았어도 하나만 생긴다, C1). 의도(글·그림·비공개)가 바뀌면 새로 뽑는다.
  //  세션·재인증만으로는 바꾸지 않는다. 처음 보낸 계정·저장 대상·서버 주소에 묶여, 그것이 달라지면 같은 id 로도 새 id 로도 다시 보내지 않는다.
  const commentIdRef = useRef(uuid());
  const sentSigRef = useRef<string | null>(null);
  const boundRef = useRef<string | null>(null);

  // ── 그림 판(프레임별) ──
  const sheetsRef = useRef(new Map<number, Sheet>());
  const [, setSheetsTick] = useState(0);
  const bump = () => setSheetsTick((n) => n + 1);
  const curKeyRef = useRef(isVideo ? frameOf(startTime) : 0);
  const draw = useDrawingInput({ src: work, active: !!work && !sending, onStrokeStart: () => beginSheet() });
  const itemsRef = useRef(draw.items);
  itemsRef.current = draw.items;
  const liveSheets = (): Sheet[] =>
    [...sheetsRef.current.values()]
      .map((s) => (s.key === curKeyRef.current ? { ...s, items: itemsRef.current } : s))
      .filter((s) => s.items.length > 0)
      .sort((a, b) => (a.timeSec ?? 0) - (b.timeSec ?? 0));
  const sheets = liveSheets();

  const dropSheet = (key: number) => {
    const sheet = sheetsRef.current.get(key);
    if (sheet?.thumb) URL.revokeObjectURL(sheet.thumb.url);
    sheetsRef.current.delete(key);
  };
  useEffect(() => () => {
    for (const s of sheetsRef.current.values()) if (s.thumb) URL.revokeObjectURL(s.thumb.url);
  }, []);
  // 다른 프레임으로 가면 지금 프레임의 그림을 판에 맡기고 그 프레임의 것을 꺼낸다(그린 것이 없으면 판을 버린다 — 책갈피도 사라진다)
  //  이미지는 판마다 번호 — 캡쳐하면 다음 번호의 빈 판으로 넘어간다(떠난 판은 '붙은 장'이 된다).
  const switchToKey = (key: number) => {
    if (key === curKeyRef.current) return;
    const cur = sheetsRef.current.get(curKeyRef.current);
    if (cur) {
      cur.items = itemsRef.current;
      if (!cur.items.length) dropSheet(cur.key);
      else cur.captured = true; // 그리던 것을 두고 다른 판으로 가면 붙은 장으로 남는다(잃지 않게)
    }
    curKeyRef.current = key;
    draw.cancelText();
    draw.setItems(sheetsRef.current.get(key)?.items ?? []);
    draw.setRedo([]);
    bump();
  };
  const syncKey = (at: number) => {
    if (isVideo) switchToKey(frameOf(at));
  };
  const nextKeyRef = useRef(1); // 이미지 판 번호
  // 캡쳐(이미지) — 지금 그림판을 붙은 장으로 넘기고 빈 판에서 다시 그린다
  const captureSheet = () => {
    if (!itemsRef.current.length || !sheetsRef.current.get(curKeyRef.current)) {
      flashMsg("캡쳐할 그림이 없습니다 — 먼저 그려 주세요");
      return;
    }
    if (sheets.length >= MAX_DRAWINGS) {
      flashMsg(`그림은 코멘트 하나에 ${MAX_DRAWINGS}장까지 붙일 수 있습니다`);
      return;
    }
    switchToKey(nextKeyRef.current++);
  };
  // 처음 그릴 때 판을 만든다 — 기준 시각은 지금 video.currentTime 으로 고정, 영상은 그 장면의 미리보기를 뜬다
  function beginSheet(): boolean {
    const video = videoRef.current;
    // 장면을 옮기는 중(seeked 전)이면 아직 앞 장면이 보인다 — 보고 그린 장면과 저장 장면이 어긋나지 않게 이 누름은 그리지 않는다
    if (isVideo && video?.seeking) return false;
    if (isVideo && video && !video.paused) {
      video.pause();
      setPlaying(false);
      syncKey(video.currentTime);
    }
    const key = curKeyRef.current;
    const existing = sheetsRef.current.get(key);
    if (existing) {
      // 같은 칸의 다른 시각에 서 있으면 그 그림의 기준 시각 장면으로 옮기고 이 누름은 버린다(장면이 뜬 뒤 다시 누른다)
      return !snapTo(existing);
    }
    if (sheets.length >= MAX_DRAWINGS) {
      flashMsg(`그림은 코멘트 하나에 ${MAX_DRAWINGS}장까지 붙일 수 있습니다`);
      return false;
    }
    const sheet: Sheet = { id: uuid(), key, timeSec: isVideo ? (video?.currentTime ?? time) : null, items: [], thumb: null, thumbJob: null, captured: false };
    if (isVideo && video) {
      sheet.thumbJob = frameThumb(video).then((made) => {
        if (sheetsRef.current.get(key) === sheet) {
          sheet.thumb = made;
          bump();
        } else if (made) URL.revokeObjectURL(made.url); // 그사이 지운 판의 늦은 결과는 버린다
      });
    }
    sheetsRef.current.set(key, sheet);
    bump();
    return true;
  }
  const removeSheet = (key: number) => {
    if (key === curKeyRef.current) draw.clearStrokes();
    dropSheet(key);
    bump();
  };

  // ── 영상 조작(수정 창과 같은 24fps 눈금) ──
  /** 그 그림의 기준 시각 장면으로 옮긴다 — 옮겼으면 true(장면이 뜨기 전이라 이 누름으로는 그리지 않는다). */
  function snapTo(sheet: Sheet): boolean {
    const video = videoRef.current;
    if (!isVideo || !video || sheet.timeSec == null || Math.abs(video.currentTime - sheet.timeSec) < 1e-4) return false;
    video.currentTime = sheet.timeSec;
    setTime(sheet.timeSec);
    return true;
  }
  // 작성용 탐색 — 그림이 있는 칸이면 그 그림의 기준 시각으로 멈춘다(60fps 영상은 한 칸에 장면이 여럿이라 다른 장면 위에 그 그림을 고치게 된다)
  const seekTo = (at: number) => {
    const video = videoRef.current;
    if (!video) return;
    if (!video.paused) video.pause();
    setPlaying(false);
    pendingViewRef.current = null;
    const clamped = Math.min(Math.max(0, at), Math.max(0, (duration || video.duration || 0) - 1 / EDIT_FPS));
    const t = sheetsRef.current.get(frameOf(clamped))?.timeSec ?? clamped;
    video.currentTime = t;
    setTime(t);
    syncKey(t);
  };
  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (!video.paused) {
      seekTo(video.currentTime);
      return;
    }
    draw.cancelText();
    setViewing(null);
    if (video.currentTime >= duration - 1 / EDIT_FPS) video.currentTime = 0;
    setPlaying(true);
    Promise.resolve(video.play()).catch(() => setPlaying(false));
  };
  const scrubbingRef = useRef(false);
  const scrubTime = (e: React.PointerEvent<HTMLDivElement>) => {
    const track = e.currentTarget.querySelector(".pe-scrub-track")?.getBoundingClientRect();
    if (!track?.width || !duration) return null;
    return Math.min(1, Math.max(0, (e.clientX - track.left) / track.width)) * duration;
  };
  // 지난 그림 보기 — 그 그림의 정확한 time_sec 로 '보기용 탐색'을 하고, 탐색이 끝난 뒤 획을 겹친다(작성용 seekTo 의 칸 맞춤을 쓰지 않는다 — Codex P1-5)
  const openViewing = (view: CommentDrawingView) => {
    const video = videoRef.current;
    const at = view.drawing.time_sec;
    if (!isVideo || !video || at == null) {
      setViewing(view);
      return;
    }
    if (!video.paused) video.pause();
    setPlaying(false);
    setViewing(null);
    syncKey(at);
    if (Math.abs(video.currentTime - at) < 1e-4) {
      setViewing(view);
      return;
    }
    pendingViewRef.current = view;
    video.currentTime = at;
    setTime(at);
  };

  // ── 지난 코멘트의 그림(영상 책갈피 · 오른쪽 칸) ──
  const pastComments: { id: string; author_name: string | null; drawings?: CommentDrawingMeta[] }[] = isAsset ? (assetSide?.comments ?? []) : genComments;
  const pastMarks = isVideo
    ? pastComments.flatMap((c) => (c.drawings ?? [])
      .filter((d) => d.kind === "video" && d.time_sec != null)
      .map((d) => ({ commentId: c.id, drawing: d, author: c.author_name })))
    : [];

  // ── 보내기 ──
  const dirty = !!text.trim() || sheets.length > 0;
  useEffect(() => {
    holdUnload("comment:draw", dirty); // 쓰던 코멘트·그림이 있는 동안 창을 닫거나 새로고침하면 묻는다("코멘트")
    return () => holdUnload("comment:draw", false);
  }, [dirty]);
  // 작성 의도가 바뀌었다 — 코멘트와 그림 식별자를 함께 새로 뽑고, 처음 보낸 문맥 묶음도 푼다(새 작성)
  const renewIds = () => {
    commentIdRef.current = uuid();
    for (const sheet of sheetsRef.current.values()) sheet.id = uuid();
    sentSigRef.current = null;
    boundRef.current = null;
    bump();
  };
  const resetDraft = () => {
    for (const key of [...sheetsRef.current.keys()]) dropSheet(key);
    draw.clearStrokes();
    setText("");
    setNotice(null);
    renewIds();
  };
  const contextMoved = (op: ReturnType<typeof captureOperationContext>) => !isOperationContextCurrent(op);
  const send = async () => {
    const body = text.trim();
    if (sending || !body || !natural || !work) return;
    if (isAsset && !writeContext) {
      setNotice({ text: "보내지 않았습니다 — 계정·서버 상태를 아직 확인하지 못했습니다. 잠시 뒤 다시 누르세요" });
      return;
    }
    const current = sheetsRef.current.get(curKeyRef.current);
    if (current) current.items = itemsRef.current;
    // 의도 = 글·비공개·그림 내용(식별자 밖). 앞서 보낸 것과 다르면 새 작성 — 새 id(그림 id 까지 바꾼 뒤에 붙일 장을 모은다)
    const sig = JSON.stringify([body, writePrivate, liveSheets().map((s) => [s.timeSec, s.items])]);
    if (sentSigRef.current !== null && sentSigRef.current !== sig) renewIds();
    const attached = liveSheets();
    const expectation = isAsset && writeContext ? expectationFor(writeContext, writePrivate) : null;
    const binding = JSON.stringify(isAsset && writeContext ? [writeContext.expectAccount, expectation] : [getAccountNamespace(), writePrivate]);
    if (boundRef.current !== null && boundRef.current !== binding) {
      setNotice({ text: "보내지 않았습니다 — 처음 보낸 때와 계정·저장 위치가 다릅니다. 앞서 보낸 것이 저장됐는지 목록을 확인하세요", renew: "새 코멘트로 보내기" });
      return;
    }
    const op = captureOperationContext(NO_WORKSPACE);
    setSending(true);
    setNotice(null);
    let sent = false; // 요청이 나갔나 — 결과를 모르는 실패와 보내기 전 멈춤을 가른다
    try {
      if (!attached.length) {
        // 글만 — 옛 경로(옛 서버도 받는다)
        if (contextMoved(op)) throw new StopBeforeSend();
        sent = true;
        sentSigRef.current = sig;
        boundRef.current = binding;
        if (target.kind === "asset") await api.addAssetComment(target.project, target.path, body, null, writePrivate);
        else await api.addGenComment(target.genId, body, null, writePrivate);
      } else {
        if (contextMoved(op)) throw new StopBeforeSend();
        await Promise.all(attached.map((s) => s.thumbJob)); // 미리보기를 기다린다 — 다시 보낼 때 내용이 달라지지 않게
        if (contextMoved(op)) throw new StopBeforeSend();
        const drawings: CommentDrawingIn[] = await Promise.all(attached.map(async (s, idx) => {
          const strokes = toStrokesV1(s.items, work, natural.w, natural.h);
          const kind = isVideo ? "video" : "image";
          const timeSec = isVideo ? s.timeSec : null;
          const shot = isVideo ? s.thumb : null;
          const hash = await drawingHash({ strokes, kind, width: natural.w, height: natural.h, timeSec, idx, thumb: shot?.bytes ?? null });
          return {
            id: s.id, idx, kind, width: natural.w, height: natural.h, time_sec: timeSec,
            strokes: strokes as CommentDrawingIn["strokes"], thumb_b64: shot?.b64 ?? null, content_hash: hash,
          };
        }));
        if (contextMoved(op)) throw new StopBeforeSend(); // 해시 뒤·전송 직전
        sent = true;
        sentSigRef.current = sig;
        boundRef.current = binding;
        const base = { id: commentIdRef.current, text: body, parent_id: null, private: writePrivate, drawings };
        const res = target.kind === "asset" && writeContext && expectation
          ? await api.addAssetCommentV2({ ...base, project: target.project, path: target.path, ...expectation }, writeContext.expectAccount)
          : await api.addGenCommentV2((target as { genId: string }).genId, base);
        // 저장된 것이 보낸 것과 같은가(C1) — 다르면 저장 실패로 보고 초안을 지킨다
        const same = res.id === base.id && res.drawings.length === drawings.length
          && res.drawings.every((d, i) => d.id === drawings[i].id && d.content_hash === drawings[i].content_hash);
        if (!same) throw new Error("저장된 그림이 보낸 것과 다릅니다 — 다시 눌러 주세요");
      }
      // 다른 문맥의 늦은 응답은 버린다 — 초안은 그대로(처음 문맥에 묶여 다른 문맥으로는 다시 보내지 않는다). 보낸 것은 알린다(독립 리뷰 P2)
      if (contextMoved(op)) {
        setNotice(MOVED_AFTER_SEND);
        return;
      }
      resetDraft();
      setSideTick((n) => n + 1);
      assetSide?.refresh();
      onSaved();
      flashMsg("코멘트를 달았습니다");
    } catch (error) {
      if (contextMoved(op) && !(error instanceof StopBeforeSend)) {
        setNotice(sent ? MOVED_AFTER_SEND : { text: "보내지 않았습니다 — 계정·연결이 바뀌었습니다. 쓰던 글·그림은 그대로입니다" });
        return;
      }
      setNotice(describeFailure(error, sent, attached.length > 0, isAsset, renewIds, setSideTick));
    } finally {
      setSending(false);
    }
  };

  // 쓰던 것이 있으면 앱 확인창(씬 삭제와 같은 HostConfirm — Jay 11-09, 브라우저 확인창 대신)으로 묻는다
  const [confirmClose, setConfirmClose] = useState(false);
  const requestClose = () => {
    if (dirty || sideUnsent) setConfirmClose(true);
    else onClose();
  };

  // ── 키 — 떠 있는 동안 크게 보기의 키·재생은 쉰다(크게 보기가 이 창이 떠 있으면 키를 넘긴다) ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (confirmClose) return; // 확인창이 떠 있는 동안 키는 그 창의 것(Enter = 버리기, Esc = 취소)
      const t = e.target instanceof Element ? e.target : null;
      const typing = !!t?.closest("input, textarea, select, [contenteditable]");
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      let handled = true;
      if (mod && !typing && (key === "z" || key === "y")) {
        if (key === "y" || e.shiftKey) draw.redoStroke();
        else draw.undoStroke();
      } else if (typing || mod || e.altKey) handled = false;
      else if (isVideo && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        seekTo((videoRef.current?.currentTime ?? time) + (e.key === "ArrowRight" ? 1 : -1) / EDIT_FPS);
      } else if (isVideo && e.key === " " && !t?.closest("button")) togglePlay();
      else if (isVideo && (e.key === "Home" || e.key === "End")) seekTo(e.key === "Home" ? 0 : duration);
      else if (e.key === "[") draw.setBrushSize((s) => Math.max(4, s - 8));
      else if (e.key === "]") draw.setBrushSize((s) => Math.min(120, s + 8));
      else if (key === "d") draw.setTool("pen");
      else if (key === "e") draw.setTool("erase");
      else if (key === "r") draw.setTool("shape");
      else if (key === "t") draw.setTool("text");
      else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  });
  // Esc 는 쓰던 글자 → 굵기 숫자 → 색 창 → 겹쳐 보던 그림 → 창 닫기(쓰던 것이 있으면 묻는다) 순서로 하나씩
  useEscapeClose(
    () => {
      if (draw.textDraftRef.current) draw.cancelText();
      else if (draw.sizeText !== null) draw.setSizeText(null);
      else if (draw.colorOpen) draw.setColorOpen(false);
      else if (viewing) setViewing(null);
      else requestClose();
    },
    true,
    true,
    true,
  );
  const modalRef = useRef<HTMLDivElement>(null);
  useModalFocus(modalRef);

  const ratio = natural ? natural.w / natural.h : 16 / 9;
  // 아래 입력 판이 빠진 만큼 무대가 왼쪽 칸 폭까지 커진다(시안 ⑥) — 높이 상한만 둔다
  const stageMax = `calc(${isVideo ? "(92vh - 300px)" : "(92vh - 250px)"} * ${ratio.toFixed(6)})`;
  const stageStyle = { aspectRatio: natural ? `${natural.w} / ${natural.h}` : undefined, width: "100%", maxWidth: stageMax };
  const curKey = curKeyRef.current;
  const capturedSheets = isVideo ? [] : sheets.filter((s) => s.captured);
  // 이미지 번호 줄 — 캡쳐해 둔 장(빈 번호) + 지금 그리는 장(채운 번호). 지금 장이 캡쳐한 장이면 제자리에서 채운다
  const pages = isVideo ? [] : [
    ...capturedSheets.map((s) => ({ key: s.key, cur: s.key === curKey })),
    ...(capturedSheets.some((s) => s.key === curKey) ? [] : [{ key: curKey, cur: true }]),
  ];
  const pct = (at: number | null) => `${duration > 0 ? Math.min(100, Math.max(0, ((at ?? 0) / duration) * 100)) : 0}%`;
  const imageBg = thumb || url;
  const frameCount = Math.max(1, Math.round(duration * EDIT_FPS));
  const ready = !isAsset || !!writeContext;
  const composer: CommentComposer = {
    text,
    setText,
    writePrivate,
    setWritePrivate: (on) => {
      try { localStorage.setItem(PRIV_KEY, on ? "1" : "0"); } catch { /* 저장만 건너뛴다 */ }
      setPrivateChoice(on);
    },
    sending,
    canSend: !!text.trim() && !!work && ready,
    onSubmit: () => void send(),
  };

  return (
    <div className="partial-edit-backdrop" onMouseDown={(e) => e.stopPropagation()}>
      <div ref={modalRef} className="partial-edit-modal cm-modal" role="dialog" aria-modal="true" aria-label="코멘트">
        <header className="partial-edit-head">
          <span className="partial-edit-title">💬 코멘트</span>
          <span className="partial-edit-sub">{name}</span>
          <button className="assets-x" onClick={requestClose} title="닫기">
            <CloseIcon />
          </button>
        </header>
        <div className="cm-body">
          <div className="cm-main">
            <div className="pe-viewer cm-viewer" style={{ width: stageMax, maxWidth: "100%" }}>
              <div className="partial-edit-stagebox" style={stageStyle}>
                {isVideo ? (
                  <div className="pe-vhost">
                    <video
                      ref={videoRef}
                      className="pe-video"
                      src={url}
                      preload="auto"
                      playsInline
                      onLoadedMetadata={(e) => {
                        const v = e.currentTarget;
                        if (v.videoWidth && v.videoHeight) setNatural({ w: v.videoWidth, h: v.videoHeight });
                        setDuration(Number.isFinite(v.duration) ? v.duration : 0);
                        if (startTime > 0) v.currentTime = startTime;
                      }}
                      onTimeUpdate={(e) => {
                        const at = e.currentTarget.currentTime;
                        setTime(at);
                        if (!e.currentTarget.paused) syncKey(at); // 재생 중에 지나는 프레임의 그림을 보인다
                      }}
                      onSeeked={() => {
                        const view = pendingViewRef.current;
                        pendingViewRef.current = null;
                        if (view) setViewing(view); // 보기용 탐색이 끝난 뒤에 겹친다
                      }}
                      onPlay={() => setPlaying(true)}
                      onPause={() => setPlaying(false)}
                    />
                  </div>
                ) : (
                  <img
                    src={url}
                    alt=""
                    draggable={false}
                    onLoad={(e) => {
                      const im = e.currentTarget;
                      if (im.naturalWidth && im.naturalHeight) setNatural({ w: im.naturalWidth, h: im.naturalHeight });
                    }}
                  />
                )}
                {viewing && <ViewingLayer view={viewing} onGone={() => setViewing(null)} />}
                {work && (
                  <canvas
                    ref={(el) => {
                      draw.annotRef.current = el;
                      if (el && (el.width !== work.w || el.height !== work.h)) {
                        el.width = work.w;
                        el.height = work.h;
                        draw.renderAll(draw.items);
                      }
                    }}
                    className={sending ? "" : "is-drawing" + (draw.tool === "text" ? " is-text" : "")}
                    onPointerDown={draw.onPointerDown}
                    onPointerMove={draw.onPointerMove}
                    onPointerEnter={draw.trackCursor}
                    onPointerLeave={draw.onPointerLeave}
                    onPointerUp={draw.endStroke}
                    onPointerCancel={draw.cancelStroke}
                    onLostPointerCapture={draw.cancelStroke}
                  />
                )}
                <div ref={draw.cursorRef} className="partial-edit-cursor" />
                {!sending && <DrawTextInput draw={draw} />}
                {viewing && (
                  <div className="cm-viewing">
                    💬 <b>{viewing.author || "팀원"}</b>
                    {viewing.drawing.kind === "video" && <span>· {secLabel(viewing.drawing.time_sec)}</span>}
                    <button type="button" onClick={() => setViewing(null)}>끄기</button>
                  </div>
                )}
              </div>
              {/* 무대 아래 한 판 — 영상: 타임라인·재생 줄·도구 줄 / 이미지: 번호 줄·도구 줄(시안 ⑥⑦) */}
              <div className="pe-board">
                {isVideo ? (
                  <>
                    <div className="pe-scrub" role="slider" aria-label="코멘트할 영상 시점" aria-valuemin={0}
                      aria-valuemax={Number(duration.toFixed(3))} aria-valuenow={Number(time.toFixed(3))}
                      onPointerDown={(e) => {
                        if (e.button !== 0 || (e.target as Element).closest(".cm-mark")) return;
                        scrubbingRef.current = true;
                        e.currentTarget.setPointerCapture?.(e.pointerId);
                        const at = scrubTime(e);
                        if (at != null) seekTo(at);
                      }}
                      onPointerMove={(e) => {
                        if (!scrubbingRef.current) return;
                        const at = scrubTime(e);
                        if (at != null) seekTo(at);
                      }}
                      onPointerUp={() => { scrubbingRef.current = false; }}
                      onPointerCancel={() => { scrubbingRef.current = false; }}>
                      <div className="pe-scrub-track">
                        <div className="pe-scrub-fill" style={{ width: pct(time) }} />
                        <div className="pe-scrub-head" style={{ left: pct(time) }} />
                        {/* 책갈피 — 채운 동그라미 = 지금 그린 프레임(지금 칸은 흰 테두리), 빈 동그라미 = 지난 코멘트 그림.
                            식별 = 그리는 판의 key / 지난 그림의 (코멘트 id, 그림 id) — 같은 칸에 여럿이어도 합치지 않는다 */}
                        <div className="cm-marks">
                          {pastMarks.map((m) => (
                            <button key={`${m.commentId}:${m.drawing.id}`} type="button" className="cm-mark past" style={{ left: pct(m.drawing.time_sec) }}
                              title={`${m.author || "팀원"} · ${secLabel(m.drawing.time_sec)} — 눌러서 겹쳐 보기`}
                              aria-label={`지난 코멘트 그림 ${secLabel(m.drawing.time_sec)}`}
                              onClick={() => openViewing({ target, commentId: m.commentId, drawing: m.drawing, author: m.author })} />
                          ))}
                          {sheets.map((s) => (
                            <button key={s.id} type="button" className={"cm-mark" + (s.key === curKey ? " cur" : "")} style={{ left: pct(s.timeSec) }}
                              title={`그린 프레임 ${secLabel(s.timeSec)}`} aria-label={`그린 프레임 ${secLabel(s.timeSec)}`}
                              onClick={() => { if (s.timeSec != null) seekTo(s.timeSec); }} />
                          ))}
                        </div>
                      </div>
                    </div>
                    <div className="pe-trans pe-trans-row">
                      <span className="pe-time">{timecode(time)} <span className="muted">/ {timecode(duration)}</span></span>
                      <div className="pe-trans-mid">
                        <button type="button" className="pe-tbtn" title="처음으로 (Home)" aria-label="처음으로" onClick={() => seekTo(0)}>
                          <svg width="16" height="14" viewBox="0 0 16 14" aria-hidden="true"><rect x="1" y="1" width="2" height="12" /><path d="M15 1v12L5 7z" /></svg>
                        </button>
                        <button type="button" className="pe-tbtn pe-step" title="한 프레임 뒤로 (←)" aria-label="한 프레임 뒤로"
                          onClick={() => seekTo((videoRef.current?.currentTime ?? time) - 1 / EDIT_FPS)}>−1f</button>
                        <button type="button" className="pe-tbtn pe-play" title="재생/정지 (Space)" aria-label="재생/정지" onClick={togglePlay}>
                          {playing
                            ? <svg width="12" height="14" viewBox="0 0 12 14" aria-hidden="true"><rect x="1.5" y="1" width="3.2" height="12" /><rect x="7.3" y="1" width="3.2" height="12" /></svg>
                            : <svg width="12" height="14" viewBox="0 0 12 14" aria-hidden="true"><path d="M2 1v12l9-6z" /></svg>}
                        </button>
                        <button type="button" className="pe-tbtn pe-step" title="한 프레임 앞으로 (→)" aria-label="한 프레임 앞으로"
                          onClick={() => seekTo((videoRef.current?.currentTime ?? time) + 1 / EDIT_FPS)}>+1f</button>
                        <button type="button" className="pe-tbtn" title="끝으로 (End)" aria-label="끝으로" onClick={() => seekTo(duration)}>
                          <svg width="16" height="14" viewBox="0 0 16 14" aria-hidden="true"><rect x="13" y="1" width="2" height="12" /><path d="M1 1v12l10-6z" /></svg>
                        </button>
                        <span className="pe-frame">{Math.min(frameCount, frameOf(time) + 1)} / {frameCount}</span>
                      </div>
                      <span className="pe-keys">← → 한 프레임 · Space 재생</span>
                    </div>
                  </>
                ) : (
                  <div className="cm-pages" aria-label="그림">
                    <span className="cm-pages-label">그림</span>
                    {pages.map((p, i) => (
                      <span key={p.key} className={"cm-page" + (p.cur ? " cur" : "")}>
                        <button type="button" className="cm-page-n" aria-label={`그림 ${i + 1}${p.cur ? " (지금 그리는 장)" : " 고치기"}`}
                          onClick={() => switchToKey(p.key)}>{circled(i + 1)}</button>
                        {sheetsRef.current.has(p.key) && (
                          <button type="button" className="cm-page-x" title="이 그림 지우기" aria-label={`그림 ${i + 1} 지우기`}
                            onClick={() => removeSheet(p.key)}>×</button>
                        )}
                      </span>
                    ))}
                    <span className="cm-pages-hint">캡쳐 = 지금 그림을 한 장으로 남기고 새로 그리기 · 전송하면 모두 그 코멘트에 붙습니다</span>
                  </div>
                )}
                <DrawDock
                  draw={draw}
                  extra={isVideo ? undefined : (
                    // 캡쳐(이미지만) — 아이콘만, 붙은 장 수 = 빨간 숫자(캡쳐 전엔 없음). Jay 11-05 시안 2차
                    <button type="button" className="cm-cap" title="캡쳐 — 그린 것을 한 장으로 붙이고 그림판을 비운다"
                      aria-label={`캡쳐${capturedSheets.length ? ` (붙은 그림 ${capturedSheets.length}장)` : ""}`}
                      disabled={sending} onClick={captureSheet}>
                      {TOOL_ICONS.capture}
                      {capturedSheets.length > 0 && <span className="cm-cap-badge">{capturedSheets.length}</span>}
                    </button>
                  )}
                />
              </div>
              {notice && (
                <div className="cm-notice" role="status">
                  <span>{notice.text}</span>
                  {notice.renew && (
                    <button type="button" disabled={sending} onClick={() => { renewIds(); setNotice(null); void send(); }}>{notice.renew}</button>
                  )}
                </div>
              )}
            </div>
          </div>
          <aside className="cm-side">
            {target.kind === "generation" ? (
              <GenCommentPanel
                embedded
                genId={target.genId}
                label={name}
                myId={myId}
                syncTick={sideTick}
                onClose={() => {}}
                onChanged={onSaved}
                drawingBg={imageBg}
                onOpenDrawing={openViewing}
                composer={composer}
                allowPrivate={allowPrivate}
                onUnsentChange={setSideUnsent}
                onComments={onGenComments}
              />
            ) : (
              <CommentPanel
                embedded
                comments={assetSide?.comments ?? []}
                label={name}
                myId={myId}
                panelRef={null}
                pos={null}
                onHeadMouseDown={() => {}}
                onClose={() => {}}
                onSend={assetSide?.onSend ?? (async () => false)}
                onEdit={assetSide?.onEdit ?? (async () => false)}
                onDelete={assetSide?.onDelete ?? (() => {})}
                targetKey={`${target.project}\u0000${target.path}`}
                composer={composer}
                allowPrivate={allowPrivate}
                onUnsentChange={setSideUnsent}
                renderExtra={(c) => (
                  <CommentDrawingStrip target={target} comment={c} bg={imageBg}
                    onOpen={(drawing) => openViewing({ target, commentId: c.id, drawing, author: c.author_name })} />
                )}
              />
            )}
          </aside>
        </div>
      </div>
      {confirmClose && (
        <HostConfirm label="코멘트 닫기" title="💬 코멘트 닫기" confirmLabel="삭제"
          onConfirm={() => { setConfirmClose(false); onClose(); }} onCancel={() => setConfirmClose(false)}>
          쓰던 코멘트와 그림을 삭제할까요?
        </HostConfirm>
      )}
    </div>
  );
}

class StopBeforeSend extends Error {
  constructor() { super("계정·연결이 바뀌어 보내지 않았습니다"); }
}

const MOVED_AFTER_SEND: Notice = { text: "보낸 뒤 계정·연결이 바뀌어 결과를 확인하지 못했습니다 — 앞선 요청은 저장됐을 수 있습니다. 목록을 확인하세요" };

/** 실패를 세 갈래(보내지 않음 · 결과 모름 · 받는 쪽의 판정)로 안내한다 — 어느 경우든 초안은 지킨다.
 *  retryable = 같은 id 로 다시 보내면 장부가 처음 결과를 돌려주는 길(comments-v2). 글만 보내는 옛 길은 id 가 없어 다시 보내면 두 번 생길 수 있다. */
function describeFailure(error: unknown, sent: boolean, retryable: boolean, isAsset: boolean, renewIds: () => void,
  setSideTick: (fn: (n: number) => number) => void): Notice {
  if (error instanceof StopBeforeSend) return { text: "보내지 않았습니다 — 계정·연결이 바뀌었습니다. 쓰던 글·그림은 그대로입니다" };
  if (error instanceof StrokesTooLarge) return { text: error.message };
  if (error instanceof ApiPausedError) return { text: API_PAUSED_MESSAGE };
  const code = error instanceof HttpError ? String(error.info?.code ?? "") : "";
  if (isAsset && code) {
    if (code === "stored_local") return { text: "이 PC 에 저장됨 · 팀에 저장 안 됨 — 서버 연결 전에 이 PC 에만 저장된 코멘트입니다", renew: "팀에 새로 보내기" };
    if (code === "conflict") return { text: "같은 코멘트 번호로 다른 내용이 이미 저장돼 있습니다 — 목록을 확인하세요", renew: "새 코멘트로 보내기" };
    if (code === "deleted") return { text: "이미 지워진 코멘트입니다", renew: "새 코멘트로 보내기" };
    if (code === "context_changed") return { text: "보내지 않았습니다 — 화면과 허브의 계정·저장 위치가 다릅니다. 새로 고친 뒤 다시 보내세요" };
    if (code === "server_update_needed") return { text: "팀 서버 업데이트 뒤 그림을 붙일 수 있습니다 — 쓰던 글·그림은 그대로입니다" };
  }
  if (!isAsset && error instanceof HttpError && error.status === 410) {
    renewIds(); // 지워진 코멘트 id — 다시 만들지 않는다. 새 id 로 다시 보내게(생성물 기존 동작)
    return { text: "이 코멘트는 지워진 것으로 기록돼 있습니다 — 한 번 더 누르면 새 코멘트로 보냅니다" };
  }
  if (!isAsset && error instanceof HttpError && error.status === 409 && /comment_id|drawing_id/.test(error.detail)) {
    // 앞서 보낸 것이 이미 저장됐는데 그 뒤 고쳤다 — 고친 것은 새 코멘트·새 그림으로(생성물 기존 동작)
    renewIds();
    setSideTick((n) => n + 1);
    return { text: "앞서 보낸 코멘트가 이미 저장됐습니다 — 지난 코멘트를 확인한 뒤, 고친 것을 보내려면 한 번 더 누르세요" };
  }
  if (!sent) return { text: `보내지 않았습니다 — ${errorDetail(error)}` };
  if (error instanceof HttpError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) {
    return { text: `코멘트를 달지 못했습니다 — ${errorDetail(error)}` }; // 받는 쪽이 거절했다(저장 안 됨)
  }
  // 연결 실패·시간 초과·서버 오류 — 들어갔는지 모른다. 그림 길은 같은 계정·대상이면 다시 눌러 같은 id 로(장부가 처음 결과를 돌려준다)
  if (!retryable) return { text: "이번 전송의 결과를 모릅니다 — 저장됐을 수 있습니다. 목록을 확인한 뒤 다시 보내세요(글만 보내는 코멘트는 다시 보내면 두 번 생길 수 있습니다)" };
  return { text: "이번 전송의 결과를 모릅니다 — 앞선 요청은 저장됐을 수 있습니다. 다시 누르면 같은 코멘트로 확인합니다" };
}
