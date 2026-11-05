// 크게 보기 코멘트 모드 창 — 그림을 그려 코멘트에 붙인다(설계 docs/status/크게보기_코멘트그림_설계_2026-11-05.md §3.1·§3.7·§10 C1·C6).
//  왼쪽 = 무대(이미지·영상) + 수정 창과 같은 그리기 도구 + 아래 판(붙는 그림 · 입력 · 🔒 비공개로 쓰기 · [코멘트 달기]), 오른쪽 = 지난 코멘트.
//  영상은 프레임마다 그린다 — 그린 프레임에 책갈피가 생기고 그 프레임 그림이 한 장씩 붙는다(24fps 가상 눈금의 같은 칸 = 같은 책갈피).
//  그림의 기준 시각은 그 프레임에 처음 그릴 때의 video.currentTime 으로 고정한다(C6). 그림이 있을 때만 comments-v2, 글만이면 옛 경로.
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api";
import { EDIT_FPS, timecode } from "../../lib/editTimeline";
import { flashMsg } from "../../lib/flash";
import { API_PAUSED_MESSAGE, ApiPausedError, HttpError, errorDetail } from "../../lib/http";
import { useModalFocus } from "../../lib/keyGate";
import { videoFramePng } from "../../lib/mediaCapture";
import { holdUnload } from "../../lib/unloadGuard";
import { useEscapeClose } from "../../lib/useEscapeClose";
import type { CommentDrawingIn, CommentDrawingView } from "../../types";
import { CloseIcon } from "../common/ViewIcons";
import { DrawDock, DrawTextInput, TOOL_ICONS } from "../edit/drawing/DrawDock";
import { drawingHash, MAX_DRAWINGS, StrokesTooLarge, toStrokesV1, type DrawItem } from "../edit/drawing/strokes";
import { useDrawingInput } from "../edit/drawing/useDrawingInput";
import { GenCommentPanel, StrokesCanvas, UNSUPPORTED_DRAWING, secLabel, useCommentDrawing } from "../GenCommentPanel";

const MAX_WORK_PIXELS = 12_000_000; // 그리는 캔버스만 줄인다 — 좌표계는 원본 크기(C4)
const THUMB_SIDE = 320; // 영상 그림의 목록용 미리보기 긴 변(설계 §3.2)
const THUMB_MAX_BYTES = 64 * 1024;
const PRIV_KEY = "ch.cmt.private"; // 코멘트 창과 같은 '다음 코멘트를 비공개로' 설정

function workSize(w: number, h: number) {
  const k = Math.min(1, Math.sqrt(MAX_WORK_PIXELS / (w * h)));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}
const frameOf = (time: number) => Math.round(time * EDIT_FPS);

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
//  captured = 이미지에서 붙은 장(캡쳐했거나 다른 판으로 넘어감) — 붙는 그림 칸·빨간 숫자에 보인다. 보낼 때는 캡쳐 안 한 판도 함께 간다.
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

/** 붙는 그림 칸의 작은 그림 — 그리는 캔버스 좌표(work)의 획을 줄여 그린다. */
function SheetCanvas({ items, work }: { items: DrawItem[]; work: { w: number; h: number } }) {
  return <StrokesCanvas items={items} width={work.w} height={work.h} maxPx={160} />;
}

/** 지난 코멘트의 그림을 무대 위에 겹쳐 본다(읽기 전용). */
function ViewingLayer({ view, onGone }: { view: CommentDrawingView; onGone: () => void }) {
  const state = useCommentDrawing(view.commentId, view.drawing);
  useEffect(() => {
    if (state.status === "gone") onGone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status]);
  if (state.status === "unsupported") return <div className="cm-view-note">{UNSUPPORTED_DRAWING}</div>;
  if (state.status !== "ok") return null;
  return <StrokesCanvas className="cm-view-layer" items={state.items} width={view.drawing.width} height={view.drawing.height} maxPx={2048} />;
}

interface Props {
  genId: string;
  type: "image" | "video";
  url: string;
  thumb?: string | null;
  name: string;
  myId: string;
  startTime?: number; // 영상 — 크게 보기에서 보던 시각
  // 비공개로 쓸 수 있나 — 로컬 허브만(서버 직결 화면은 서버가 비공개를 받지 않는다: 입력을 숨긴다)
  allowPrivate?: boolean;
  onClose: () => void;
  onSaved: () => void; // 코멘트를 달았다(크게 보기의 C 단추 상태를 다시 읽는다)
}

export function CommentDrawModal({ genId, type, url, thumb, name, myId, startTime = 0, allowPrivate = true, onClose, onSaved }: Props) {
  const isVideo = type === "video";
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const work = useMemo(() => (natural ? workSize(natural.w, natural.h) : null), [natural]);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [time, setTime] = useState(startTime);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [privateChoice, setWritePrivate] = useState(() => {
    try {
      return localStorage.getItem(PRIV_KEY) === "1";
    } catch {
      return false;
    }
  });
  const writePrivate = allowPrivate && privateChoice;
  const [viewing, setViewing] = useState<CommentDrawingView | null>(null);
  const [sideTick, setSideTick] = useState(0);
  // 같은 코멘트를 다시 보낼 때 같은 id — 답을 못 받았어도 하나만 생긴다(C1). 저장되면 새로 뽑는다.
  const commentIdRef = useRef(uuid());

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
  const seekTo = (at: number) => {
    const video = videoRef.current;
    if (!video) return;
    if (!video.paused) video.pause();
    setPlaying(false);
    const clamped = Math.min(Math.max(0, at), Math.max(0, (duration || video.duration || 0) - 1 / EDIT_FPS));
    // 그림이 있는 칸이면 그 그림의 기준 시각으로 멈춘다 — 60fps 영상은 한 칸에 장면이 여럿이라 다른 장면 위에 그 그림을 고치게 된다
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

  // ── 보내기 ──
  const dirty = !!text.trim() || sheets.length > 0;
  useEffect(() => {
    holdUnload("comment:draw", dirty); // 쓰던 코멘트·그림이 있는 동안 창을 닫거나 새로고침하면 묻는다("코멘트")
    return () => holdUnload("comment:draw", false);
  }, [dirty]);
  // 작성 의도가 바뀌었다(앞 요청이 이미 저장됨·지워진 id) — 코멘트와 그림 식별자를 함께 새로 뽑는다(C1)
  const renewIds = () => {
    commentIdRef.current = uuid();
    for (const sheet of sheetsRef.current.values()) sheet.id = uuid();
    bump();
  };
  const resetDraft = () => {
    for (const key of [...sheetsRef.current.keys()]) dropSheet(key);
    draw.clearStrokes();
    setText("");
    renewIds();
  };
  const send = async () => {
    const body = text.trim();
    if (sending || !body || !natural || !work) return;
    const current = sheetsRef.current.get(curKeyRef.current);
    if (current) current.items = itemsRef.current;
    const attached = liveSheets();
    setSending(true);
    try {
      if (!attached.length) {
        // 글만 — 옛 경로(옛 서버도 받는다)
        await api.addGenComment(genId, body, null, writePrivate);
      } else {
        await Promise.all(attached.map((s) => s.thumbJob)); // 미리보기를 기다린다 — 다시 보낼 때 내용이 달라지지 않게
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
        const res = await api.addGenCommentV2(genId, { id: commentIdRef.current, text: body, parent_id: null, private: writePrivate, drawings });
        // 저장된 것이 보낸 것과 같은가(C1) — 다르면 저장 실패로 보고 초안을 지킨다
        const same = res.drawings.length === drawings.length
          && res.drawings.every((d, i) => d.id === drawings[i].id && d.content_hash === drawings[i].content_hash);
        if (!same) throw new Error("저장된 그림이 보낸 것과 다릅니다 — 다시 눌러 주세요");
      }
      resetDraft();
      setSideTick((n) => n + 1);
      onSaved();
      flashMsg("코멘트를 달았습니다");
    } catch (error) {
      if (error instanceof StrokesTooLarge) flashMsg(error.message);
      else if (error instanceof ApiPausedError) flashMsg(API_PAUSED_MESSAGE);
      else if (error instanceof HttpError && error.status === 410) {
        renewIds(); // 지워진 코멘트 id — 다시 만들지 않는다. 새 id 로 다시 보내게
        flashMsg("이 코멘트는 지워진 것으로 기록돼 있습니다 — 한 번 더 누르면 새 코멘트로 보냅니다");
      } else if (error instanceof HttpError && error.status === 409 && /comment_id|drawing_id/.test(error.detail)) {
        // 앞서 보낸 것이 이미 저장됐는데 그 뒤 고쳤다 — 고친 것은 새 코멘트·새 그림으로(그림 id 도 앞 코멘트가 가졌다)
        renewIds();
        setSideTick((n) => n + 1);
        flashMsg("앞서 보낸 코멘트가 이미 저장됐습니다 — 지난 코멘트를 확인한 뒤, 고친 것을 보내려면 한 번 더 누르세요");
      } else flashMsg(`코멘트를 달지 못했습니다 — ${errorDetail(error)}`); // 쓴 글·그림은 그대로(같은 id 로 다시 보낼 수 있다)
    } finally {
      setSending(false);
    }
  };

  const requestClose = () => {
    if (dirty && !window.confirm("쓰던 코멘트와 그림을 버릴까요?")) return;
    onClose();
  };
  const openViewing = (view: CommentDrawingView) => {
    setViewing(view);
    if (isVideo && view.drawing.time_sec != null) seekTo(view.drawing.time_sec);
  };

  // ── 키 — 떠 있는 동안 크게 보기의 키·재생은 쉰다(크게 보기가 이 창이 떠 있으면 키를 넘긴다) ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
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
  const stageStyle = {
    aspectRatio: natural ? `${natural.w} / ${natural.h}` : undefined,
    width: "100%",
    // 영상 높이 상한은 수정 창과 같은 50vh−124px(Jay 11-05 — 비율이 다르면 이미지도 꽉 차지 않으니 영상만 따로 맞추지 않는다)
    maxWidth: `calc(${isVideo ? "(50vh - 124px)" : "58vh"} * ${ratio.toFixed(6)})`,
  };
  const curKey = curKeyRef.current;
  // 붙는 그림 칸 — 영상은 그린 프레임 모두, 이미지는 붙은 장(캡쳐했거나 다른 판으로 넘어간 것)만. 빨간 숫자 = 이미지의 붙은 장 수
  const shownSheets = isVideo ? sheets : sheets.filter((s) => s.captured);
  const pct = (at: number | null) => `${duration > 0 ? Math.min(100, Math.max(0, ((at ?? 0) / duration) * 100)) : 0}%`;
  const imageBg = thumb || url;

  return (
    <div className="partial-edit-backdrop" onMouseDown={(e) => e.stopPropagation()}>
      <div ref={modalRef} className="partial-edit-modal cm-modal" role="dialog" aria-modal="true" aria-label="코멘트">
        <header className="partial-edit-head">
          <span className="partial-edit-title">💬 코멘트</span>
          <span className="partial-edit-sub">
            {isVideo
              ? "프레임을 옮겨 가며 표시하고 코멘트 — 그린 프레임마다 책갈피가 생기고 그림이 코멘트에 붙습니다"
              : "그림 위에 표시하고 캡쳐 — 여러 장을 그려 한 코멘트에 붙일 수 있습니다"}
          </span>
          <button className="assets-x" onClick={requestClose} title="닫기">
            <CloseIcon />
          </button>
        </header>
        <div className="cm-body">
          <div className="cm-main">
            <div className={isVideo ? "pe-viewer" : "pe-plain"} style={isVideo ? { width: stageStyle.maxWidth, maxWidth: "100%" } : undefined}>
              {isVideo && (
                <div className="pe-vtop">
                  <span className="pe-vtc">{timecode(time)}</span>
                  <span className="pe-vlabel">코멘트할 프레임 <b>{Math.round(time * EDIT_FPS) + 1}</b> / {Math.max(1, Math.round(duration * EDIT_FPS))}</span>
                  {sheets.length > 0 && <span className="cm-count"><i className="cm-bm" /> 그린 프레임 {sheets.length}</span>}
                  <span className="pe-vtc pe-vtotal">{timecode(duration)}</span>
                </div>
              )}
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
              {isVideo && (
                <div className="pe-vbot">
                  <div className="pe-scrub" role="slider" aria-label="코멘트할 영상 시점" aria-valuemin={0}
                    aria-valuemax={Number(duration.toFixed(3))} aria-valuenow={Number(time.toFixed(3))}
                    onPointerDown={(e) => {
                      if (e.button !== 0) return;
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
                      {/* 책갈피 = 그린 프레임(지금 프레임은 흰색) */}
                      <div className="cm-marks">
                        {sheets.map((s) => (
                          <span key={s.id} className={"cm-mark" + (s.key === curKey ? " cur" : "")} style={{ left: pct(s.timeSec) }} />
                        ))}
                      </div>
                    </div>
                  </div>
                  <div className="pe-trans">
                    <span className="pe-keys">← → 한 프레임 · Space 재생</span>
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
                  </div>
                </div>
              )}
            </div>
            <DrawDock
              draw={draw}
              extra={isVideo ? undefined : (
                // 캡쳐(이미지만) — 아이콘만, 붙은 장 수 = 빨간 숫자(캡쳐 전엔 없음). Jay 11-05 시안 2차
                <button type="button" className="cm-cap" title="캡쳐 — 그린 것을 한 장으로 붙이고 그림판을 비운다"
                  aria-label={`캡쳐${shownSheets.length ? ` (붙은 그림 ${shownSheets.length}장)` : ""}`}
                  disabled={sending} onClick={captureSheet}>
                  {TOOL_ICONS.capture}
                  {shownSheets.length > 0 && <span className="cm-cap-badge">{shownSheets.length}</span>}
                </button>
              )}
            />
            <div className="sl-panel pe-prompt">
              {/* 붙는 그림 — 그림만. 마우스를 올린 그림에 × · 누르면 그 프레임으로(이미지는 그 그림을 다시 불러와 고친다) */}
              <div className="sl-reftray" aria-label="붙는 그림">
                <div className="sl-reftray-scroll">
                  {shownSheets.map((s, i) => {
                    const back = isVideo ? s.thumb?.url : imageBg;
                    return (
                      <div key={s.id} className="sl-reftray-item cm-att" title={isVideo ? timecode(s.timeSec ?? 0) : `그림 ${i + 1}`}>
                        <button type="button" className={"cm-thumb" + (s.key === curKey ? " cur" : "")}
                          aria-label={isVideo ? `${secLabel(s.timeSec)} 프레임으로` : `그림 ${i + 1} 고치기`}
                          onClick={() => {
                            if (isVideo) { if (s.timeSec != null) seekTo(s.timeSec); }
                            else switchToKey(s.key);
                          }}>
                          {back && <img src={back} alt="" draggable={false} />}
                          {work && <SheetCanvas items={s.items} work={work} />}
                        </button>
                        <span className="sl-reftray-name">{isVideo ? secLabel(s.timeSec) : `그림 ${i + 1}`}</span>
                        <button type="button" className="sl-reftray-x" title="이 그림 지우기" aria-label="이 그림 지우기" onClick={() => removeSheet(s.key)}>×</button>
                      </div>
                    );
                  })}
                  {!shownSheets.length && (
                    <div className="sl-reftray-empty">
                      {isVideo
                        ? "프레임을 옮겨 가며 위에 그리면 그 프레임 그림이 여기에 붙습니다"
                        : "그리고 캡쳐하면 그린 것이 여기에 한 장씩 붙습니다 — 캡쳐 안 한 그림도 [코멘트 달기] 때 함께 붙습니다"}
                    </div>
                  )}
                </div>
              </div>
              <div className="sl-prompt-row">
                <textarea
                  className="sl-prompt cm-text"
                  aria-label="코멘트"
                  rows={2}
                  value={text}
                  readOnly={sending}
                  placeholder={writePrivate ? "비공개 코멘트 — 팀에게 안 보입니다 (Enter 로 달기)" : "코멘트를 쓰세요 (Enter 로 달기 · Shift+Enter 줄바꿈)"}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.nativeEvent.isComposing || e.keyCode === 229) return; // 한글 조합 중 Enter 는 보내기가 아니다
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                />
              </div>
              <div className="sl-controls">
                <div className="sl-left">
                  {allowPrivate && (
                    <button type="button" className={"sl-chip" + (writePrivate ? " on" : "")} aria-pressed={writePrivate}
                      title="개인 기록으로 저장 — 팀 공유 스레드·발행에 안 나감"
                      onClick={() => setWritePrivate((v) => {
                        try { localStorage.setItem(PRIV_KEY, v ? "0" : "1"); } catch { /* 저장만 건너뛴다 */ }
                        return !v;
                      })}>
                      <span>🔒</span>
                      <span className="sl-chip-label">비공개로 쓰기</span>
                    </button>
                  )}
                </div>
                <button type="button" className="sl-gen partial-edit-gen" disabled={sending || !text.trim() || !work} onClick={() => void send()}>
                  {sending ? "보내는 중" : "코멘트 달기"}
                </button>
              </div>
            </div>
          </div>
          <aside className="cm-side">
            <GenCommentPanel
              embedded
              genId={genId}
              label={name}
              myId={myId}
              syncTick={sideTick}
              onClose={() => {}}
              onChanged={onSaved}
              drawingBg={imageBg}
              onOpenDrawing={openViewing}
            />
          </aside>
        </div>
      </div>
    </div>
  );
}
