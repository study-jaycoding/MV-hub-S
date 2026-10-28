// 부분 수정 모달 — 힉스필드 웹 편집기와 같은 원리(2026-09-01 실측으로 확정):
// 펜·도형으로 그린 표시는 '이미지에 구워져' 모델에게 그대로 전송된다(웹 편집기의 실제 전송
// 입력 이미지에 라임 동그라미가 박혀 있음을 확인). Seedream 이 낙서를 지시로 해석해 반영하고
// 낙서 없는 전체 이미지를 돌려준다 — 마스크 파라미터도, 클라이언트 합성도 없다.
// 결과가 원본에 충실한 건 Seedream 의 재현 성질 덕분(실측 ≈93% 픽셀 일치) → 기본 모델(2026-10-28 부터 다른 모델도 고른다).
//
// 구조:
//  · 원본 fetchBlob→ImageBitmap (CDN 원본의 캔버스 오염 차단), 작업 해상도 상한 12MP
//  · 주석은 벡터 아이템 목록(펜 스트로크/도형, undo=pop+재렌더) → annot 캔버스에 렌더
//    (화면 표시 = 전송본과 동일한 WYSIWYG)
//  · 제출: 주석 있으면 원본+주석 평면화 PNG 를 captures 업로드(asset: 토큰, sha256 재사용) →
//    레퍼런스로 전송, 없으면 원본 URL 그대로. source_gen_id 로 계보 유지.
//  · 제출은 prepareCreate 클로저(재시도에도 idempotency key 유지)
//  · 폴링 2초 재귀 setTimeout + runToken, 180초 후에도 실패 처리하지 않고 '오래 걸림' 안내만
//  · 결과 = 전체 이미지 표시(원본 비교 꾹) — 카드는 라이브러리에 그대로 남는다
import { useModalFocus } from "../../lib/keyGate";
import { useEscapeClose } from "../../lib/useEscapeClose";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { api, type GenerationCreateBody } from "../../api";
import { fetchBlob } from "../../lib/download";
import { flashMsg } from "../../lib/flash";
import { HttpError } from "../../lib/http";
import { generationIssueFor } from "../../lib/generationDisplay";
import { isGenerationWorkspaceReady } from "../../lib/workspaceContext";
import { holdUnload } from "../../lib/unloadGuard";
import { sharedCostEstimate, useModels } from "../../lib/useModels";
import { useModelPolicy } from "../../lib/modelPolicy";
import { modelAllowed, submitBlockMessage } from "../../lib/modelPolicyCore";
import { formatCredits } from "../../lib/formatCredits";
import { copyText } from "../../lib/flash";
import { useOutsideMouseDown } from "../../lib/useOutsideMouseDown";
import { EDIT_FPS, timecode } from "../../lib/editTimeline";
import { DRAG_TYPES } from "../../lib/dragTypes";
import { dataTransferHasFiles, filesFromDataTransfer } from "../../lib/media";
import {
  notifySpotlightAssetsChanged, parseSpotlightAssetItems, readSpotlightAssetPayload, referenceDropTypeFromFile,
  spotlightAssetRefBase, type SpotlightAssetDragItem,
} from "../../lib/spotlightAssetRefs";
import type { Generation, WorkspaceContext } from "../../types";
import { assetIdentity, assetIdentityForProject, type AssetReferenceIdentity } from "../../shared/contracts/assets";
import { captureOperationContext, isOperationContextCurrent } from "../../app/operationContext";
import { CloseIcon, CopyIcon, EraserIcon, ImageEditIcon, VideoEditIcon } from "../common/ViewIcons";
import { SpotlightOptionIcon } from "../spotlight/SpotlightOptionIcon";
import { SpotlightDurationChip } from "../spotlight/SpotlightDurationChip";

const MAX_WORK_PIXELS = 12_000_000; // 12MP — 주석/평면화 캔버스 동시 보유 상한
// 이미지 수정 기본 모델 — 웹 편집기와 동일(원본 재현 충실, 실측). 그룹 사용 모델 정책의 면제 목록과 같은 값이어야
// 부분 수정 결과물의 재생성·복구가 막히지 않는다(modelPolicyCore.POLICY_EXEMPT_MODELS).
const EDIT_MODEL = "seedream_v5_pro";
// 수정 창에서 고를 수 있는 모델 — Jay 2026-10-28 유료 시험 뒤 결정(기억 project_mvhubs_edit_model_paid_test).
// 첫 모델이 기본. 목록 머리 글은 생성창과 같은 "Image Model"·"Video Model" 하나(Jay 2026-10-28) — 회사 순서로 늘어놓는다.
// Draw to Edit(draw_to_video)는 CLI 1.2.3 로 접수가 안 돼 빠졌다 — CLI 가 되면 그때 넣는다.
const EDIT_MODELS: Record<"image" | "video", string[]> = {
  image: [EDIT_MODEL, "nano_banana_pro", "nano_banana_flash", "nano_banana_2_1", "gpt_image_2", "gpt_image_2_5"],
  video: ["kling_video_edit", "kling4_0", "seedance_2_5"],
};
const MODEL_LABELS: Record<string, string> = {
  seedream_v5_pro: "Seedream 5.0 Pro", nano_banana_pro: "Nano Banana Pro", nano_banana_flash: "Nano Banana 2",
  nano_banana_2_1: "Nano Banana 2.1", gpt_image_2: "GPT Image 2", gpt_image_2_5: "GPT Image 2.5",
  kling_video_edit: "Kling 3.0 Omni Edit", kling4_0: "Kling 4.0 · Edit video", seedance_2_5: "Seedance 2.5 · Edit video",
};
// 영상 모델마다 늘 보내는 값과 칩으로 고르는 옵션 하나(10-28 유료 시험·견적으로 확인한 계약). 비율 auto = 원본 화면 그대로
// (안 보내면 CLI 기본 16:9). seconds = 보내는 길이의 범위(CLI 가 거절하는 경계) — 처음엔 원본 길이(안 주면 Kling 4.0 은
// 10초로 과금, Seedance 는 5초). Kling 4.0 만 더 길게 고를 수 있다: 원본보다 길면 뒤로 이어 늘린다(10-28 유료 시험 — 원본 구간은 거의 그대로).
// maxImages = 그린 프레임을 포함한 이미지 레퍼런스 수 — Kling 4.0·Seedance 2.5 는 CLI 1.2.3 규칙, Kling 3.0 Omni Edit 는
// 힉스필드 웹 안내(CLI 엔 제한이 안 적힘).
const VIDEO_EDIT_PARAMS: Record<string, {
  fixed: Record<string, string>; option: string; maxImages: number;
  seconds?: { min: number; max: number; extend?: boolean }; bitrate?: boolean; audio?: boolean;
}> = {
  kling_video_edit: { fixed: {}, option: "mode", maxImages: 4 },
  kling4_0: { fixed: { mode: "video-edit", aspect_ratio: "auto" }, option: "resolution", maxImages: 10,
    seconds: { min: 3, max: 30, extend: true } },
  seedance_2_5: { fixed: { mode: "video_edit", aspect_ratio: "auto" }, option: "resolution", maxImages: 30,
    seconds: { min: 4, max: 30 }, bitrate: true, audio: true },
};
// 수정 창 레퍼런스 칸에 넣은 이미지(2번부터 — 1번은 늘 그린 프레임)
type ExtraRef = AssetReferenceIdentity & { uid: string; file_path: string; name: string; thumb: string };
const modelLabel = (id: string) => MODEL_LABELS[id] ?? id;
// Kling 3.0 Omni Edit 의 품질(mode)은 해상도다 — 힉스필드 웹처럼 해상도로 보인다. 보내는 값은 std·pro·4k 그대로(Jay 2026-10-28).
//  pro=1920×1080·4k=3840×2160 은 생성 실측, std=720p 는 웹 코드 표기.
const QUALITY_LABELS: Record<string, string> = { std: "720p", pro: "1080p", "4k": "4K" };
const bitrateLabel = (value = "") => value.charAt(0).toUpperCase() + value.slice(1); // high → High(힉스필드 웹 표기)

// 도구 캡슐의 선 아이콘(18px) — 이 창에서만 쓴다.
const TOOL_ICON = {
  viewBox: "0 0 24 24", width: 18, height: 18, fill: "none", stroke: "currentColor", strokeWidth: 2,
  strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true,
};
const TOOL_ICONS = {
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
const POLL_MS = 2_000;
const SLOW_AFTER_MS = 180_000; // 이후에도 계속 감시 — 실패 처리 아님(이중 과금 방지)

// 펜 컬러 스와치 — 웹 편집기의 구성(흰·라임·주황·빨강·민트·파랑·분홍·검정).
// 시작 색 = 레드, 이후엔 마지막 사용한 색·도구를 기억한다(Jay).
const COLORS = ["#ffffff", "#bef264", "#f59e0b", "#ef4444", "#2dd4bf", "#3b82f6", "#ec4899", "#111111"];
const DEFAULT_COLOR = "#ef4444"; // 레드
const LS_COLOR = "ch.partialEdit.color";
const LS_TOOL = "ch.partialEdit.tool";

interface PenStroke {
  kind: "pen";
  erase: boolean;
  color: string;
  size: number; // 작업 해상도 px
  points: { x: number; y: number }[];
}
type ShapeKind = "line" | "arrow" | "rect" | "ellipse";
interface ShapeItem {
  kind: "shape";
  shape: ShapeKind;
  color: string;
  size: number;
  from: { x: number; y: number };
  to: { x: number; y: number };
}
// 글자 — 누른 자리(at, 작업 해상도)가 글자 상자의 왼쪽 위. size 는 글자 높이(작업 px).
interface TextItem {
  kind: "text";
  text: string;
  color: string;
  size: number;
  at: { x: number; y: number };
}
type DrawItem = PenStroke | ShapeItem | TextItem;
const TEXT_FONT = '700 {px}px "Pretendard", "Malgun Gothic", "Apple SD Gothic Neo", sans-serif';
// 굵기(brushSize) → 글자 높이. 같은 슬라이더로 펜 굵기와 글자 크기를 함께 정한다(2배는 작은 그림에서 너무 컸다 — 10-28 실측).
const textPx = (brush: number) => Math.round(brush * 1.5);

type Stage = "load" | "draw" | "wait" | "result";

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

// 글자는 굵게 + 얇은 어두운 테두리 — 밝은 바탕·어두운 바탕 어디서나 모델이 읽게.
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

function drawItem(ctx: CanvasRenderingContext2D, it: DrawItem) {
  if (it.kind === "pen") drawPen(ctx, it);
  else if (it.kind === "text") drawText(ctx, it);
  else drawShape(ctx, it);
}

// 모델 aspect_ratio enum 에서 원본 비율에 최근접한 값 — abs(log(r/target)) 가 가로·세로 대칭.
function nearestAspect(enumValues: string[] | undefined, w: number, h: number): string | null {
  const target = w / h;
  let best: string | null = null;
  let bestDist = Infinity;
  for (const v of enumValues || []) {
    const m = /^(\d+):(\d+)$/.exec(v);
    if (!m) continue; // "auto" 등 제외
    const r = Number(m[1]) / Number(m[2]);
    const d = Math.abs(Math.log(r / target));
    if (d < bestDist) {
      bestDist = d;
      best = v;
    }
  }
  return best;
}

// Jay 10-28: 생성이 접수되면 창을 닫고 결과는 카드에서 본다. 창 안 기다림·결과 화면은 꺼 둔 채 남김
// (덩어리 삭제는 확인 뒤 따로 — Jay 09-18 규칙). false 면 옛 동작.
const CLOSE_ON_QUEUE = true;

export function PartialEditModal({
  gen,
  mode = "image",
  workspace,
  onQueued,
  onClose,
}: {
  gen: Generation;
  mode?: "image" | "video";
  workspace: WorkspaceContext;
  onQueued: (g: Generation) => void;
  onClose: () => void;
}) {
  const asset = gen.assets?.[0];
  const isVideo = mode === "video";
  const editLabel = isVideo ? "영상 수정" : "이미지 수정";
  const [stage, setStage] = useState<Stage>("load");
  const [error, setError] = useState("");
  const [note, setNote] = useState(""); // 축소 작업 등 비차단 안내

  // ── 원본 로드(작업 해상도 결정) ──
  const [src, setSrc] = useState<{ bmp: ImageBitmap; w: number; h: number } | null>(null);
  const srcUrlRef = useRef<string>("");
  const sourceVideoRef = useRef<HTMLVideoElement | null>(null);
  const sourceVideoUrlRef = useRef("");
  const [videoDuration, setVideoDuration] = useState(0);
  const [frameTime, setFrameTime] = useState(0);
  const [frameLoading, setFrameLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const frameTicket = useRef(0);
  const captureFrame = async (video: HTMLVideoElement, time: number) => {
    const ticket = ++frameTicket.current;
    setFrameLoading(true);
    try {
      // 끌어 훑는 중엔 seekTo 가 이미 그 시점으로 옮겨 두었다 — 옮기는 중(seeking)이면 끝나기만 기다린다.
      if (Math.abs(video.currentTime - time) > 0.001 || video.seeking) {
        await new Promise<void>((resolve, reject) => {
          const timer = window.setTimeout(() => reject(new Error("영상 프레임 조회 시간이 초과되었습니다.")), 30_000);
          video.onseeked = () => { clearTimeout(timer); resolve(); };
          video.onerror = () => { clearTimeout(timer); reject(new Error("영상 프레임을 불러오지 못했습니다.")); };
          if (Math.abs(video.currentTime - time) > 0.001) video.currentTime = time;
        });
      }
      const bmp = await createImageBitmap(video);
      if (ticket !== frameTicket.current || !mountedRef.current) { bmp.close(); return; }
      const scale = Math.min(1, Math.sqrt(MAX_WORK_PIXELS / (bmp.width * bmp.height)));
      const w = Math.max(1, Math.round(bmp.width * scale));
      const h = Math.max(1, Math.round(bmp.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) { bmp.close(); throw new Error("프레임 캔버스를 만들 수 없습니다."); }
      ctx.drawImage(bmp, 0, 0, w, h);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!blob) { bmp.close(); throw new Error("영상 프레임을 저장할 수 없습니다."); }
      if (ticket !== frameTicket.current || !mountedRef.current) { bmp.close(); return; }
      if (srcUrlRef.current) URL.revokeObjectURL(srcUrlRef.current);
      srcUrlRef.current = URL.createObjectURL(blob);
      setSrc({ bmp, w, h });
      setStage("draw");
    } catch (e) {
      if (ticket === frameTicket.current && mountedRef.current) setError(String(e));
    } finally {
      if (ticket === frameTicket.current && mountedRef.current) setFrameLoading(false);
    }
  };
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!asset?.file_path) {
        setError(`원본 ${isVideo ? "영상" : "이미지"}가 없습니다.`);
        return;
      }
      if (asset.type !== mode) { setError("수정할 원본 미디어 종류가 다릅니다."); return; }
      const blob = await fetchBlob(asset.file_path, isVideo ? "edit-source.mp4" : "partial-src.png", gen.id);
      if (!alive) return;
      if (!blob) {
        setError(`원본 ${isVideo ? "영상" : "이미지"}를 불러오지 못했습니다.`);
        return;
      }
      try {
        if (isVideo) {
          // 이 요소를 그대로 무대에 붙여 보인다(pe-vhost) — 끄는 동안 브라우저가 바로 그 장면을 그린다.
          const video = document.createElement("video");
          video.preload = "auto";
          video.muted = true;
          video.playsInline = true;
          video.className = "pe-video";
          video.onended = () => {
            setPlaying(false);
            setFrameTime(video.currentTime);
            void captureFrame(video, video.currentTime);
          };
          sourceVideoRef.current = video;
          sourceVideoUrlRef.current = URL.createObjectURL(blob);
          await new Promise<void>((resolve, reject) => {
            const timer = window.setTimeout(() => reject(new Error("원본 영상 조회 시간이 초과되었습니다.")), 30_000);
            video.onloadeddata = () => { clearTimeout(timer); resolve(); };
            video.onerror = () => { clearTimeout(timer); reject(new Error("원본 영상을 해석하지 못했습니다.")); };
            video.src = sourceVideoUrlRef.current;
          });
          if (!alive) return;
          if (!Number.isFinite(video.duration) || video.duration <= 0) throw new Error("원본 영상 길이를 확인할 수 없습니다.");
          setVideoDuration(video.duration);
          await captureFrame(video, 0);
          return;
        }
        const full = await createImageBitmap(blob);
        if (!alive) {
          full.close();
          return;
        }
        let w = full.width;
        let h = full.height;
        if (w * h > MAX_WORK_PIXELS) {
          const s = Math.sqrt(MAX_WORK_PIXELS / (w * h));
          w = Math.max(1, Math.round(w * s));
          h = Math.max(1, Math.round(h * s));
          setNote(`원본이 매우 커서 ${w}×${h} 작업 해상도로 축소 편집합니다.`);
        }
        srcUrlRef.current = URL.createObjectURL(blob);
        setSrc({ bmp: full, w, h });
        setStage("draw");
      } catch {
        if (alive) setError(`원본 ${isVideo ? "영상" : "이미지"}를 해석하지 못했습니다.`);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // bitmap 은 src 교체·unmount 때 그 시점의 것만 닫는다. blob URL 은 unmount 에서만
  // 정리 — [src] cleanup 에서 ref 를 revoke 하면 방금 만든 URL 을 즉시 폐기하는
  // 수명 경합이 생긴다(코덱스 WARN).
  useEffect(() => {
    const current = src;
    return () => current?.bmp.close();
  }, [src]);
  const mountedRef = useRef(true);
  useEffect(() => {
    // StrictMode 는 setup→cleanup→setup 으로 effect 를 재실행한다 — setup 에서 true 를
    // 복원하지 않으면 개발 모드에서 mountedRef 가 영구 false 가 된다(코덱스 BLOCK).
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      runTokenRef.current++; // unmount = 진행 중 폴링·지연 응답 전부 무효화
      abortRef.current?.abort(); // 걸린 감시 요청도 끊는다(브라우저 pending 정리)
      if (srcUrlRef.current) URL.revokeObjectURL(srcUrlRef.current);
      frameTicket.current++;
      sourceVideoRef.current?.pause();
      sourceVideoRef.current?.removeAttribute("src");
      sourceVideoRef.current?.load();
      if (sourceVideoUrlRef.current) URL.revokeObjectURL(sourceVideoUrlRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
  const [tool, setTool] = useState<"pen" | "erase" | "shape" | "text">(() => {
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
    if (stage === "draw") renderAll(items);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, items, src]);

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
    if (!pos || !annot || !src || stage !== "draw" || tool === "shape" || tool === "text") {
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
  }, [brushSize, tool, color, stage]);
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
    if (stage !== "draw" || activePointerRef.current != null) return;
    const p = toWork(e);
    if (!p) return;
    if (playing) seekTo(sourceVideoRef.current?.currentTime ?? frameTimeRef.current); // 재생 중이면 그 자리에 멈추고 그린다
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
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.tagName === "TEXTAREA") active.blur();
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

  // ── 모델·비율·옵션·견적 ──
  const modelPolicy = useModelPolicy();
  const openingContext = useRef(captureOperationContext(workspace));
  const openingWorkspace = useRef(JSON.stringify([workspace.scope, workspace.id]));
  const editModels = EDIT_MODELS[mode];
  const m = useModels(setError, { allowed: modelPolicy.allowed, ready: false,
    initialType: mode, initialModel: editModels[0], costEnabled: false });
  const blockedMessage = submitBlockMessage(modelPolicy, m.model, editLabel);
  const paramsReady = !m.paramsLoading && m.paramsModel === m.model && m.params.length > 0;
  // 비율은 이미지 모델만 — 영상 편집은 원본 영상의 화면을 그대로 고친다(편집 모델에 비율을 주면 화면을 다시 짠다).
  const aspectEnum = isVideo ? undefined : m.params.find((p) => p.name === "aspect_ratio")?.enum;
  const aspect = useMemo(() => {
    if (!src || !paramsReady) return null;
    return nearestAspect(aspectEnum, src.w, src.h);
  }, [src, paramsReady, aspectEnum]);
  // 영상 모델의 옵션 칩 하나(Kling 3.0 Omni Edit = 품질, 그 밖 = 해상도). 모델이 바뀌면 그 모델의 기본값으로.
  const optionName = isVideo ? VIDEO_EDIT_PARAMS[m.model]?.option ?? null : null;
  const optionParam = optionName && paramsReady ? m.params.find((p) => p.name === optionName) : undefined;
  // 목록은 내용으로 고정한다 — 배열이 렌더마다 새로 오면 견적 효과가 끝없이 다시 돈다
  const optionKey = (optionParam?.enum ?? []).join("|");
  const optionDefault = String(optionParam?.default ?? "");
  const optionValues = useMemo(() => (optionKey ? optionKey.split("|") : []), [optionKey]);
  const [option, setOption] = useState("");
  const optionLabel = (value: string) => (optionName === "mode" ? QUALITY_LABELS[value] ?? value : value);
  useEffect(() => {
    if (!optionValues.length || optionValues.includes(option)) return;
    setOption(optionValues.includes(optionDefault) ? optionDefault : optionValues[0]);
  }, [option, optionValues, optionDefault]);
  // 이미지 모델은 2k 가 있으면 2k — 시험(10-28)과 같은 조건. 없는 모델은 모델 기본값.
  const imageResolution = !isVideo && m.params.find((p) => p.name === "resolution")?.enum?.includes("2k") ? "2k" : null;
  const videoSpec = isVideo ? VIDEO_EDIT_PARAMS[m.model] : undefined;
  const baseSeconds = videoSpec?.seconds && videoDuration > 0
    ? Math.min(videoSpec.seconds.max, Math.max(videoSpec.seconds.min, Math.round(videoDuration))) : 0;
  const [seconds, setSeconds] = useState<number | null>(null); // Kling 4.0 길이 — null = 원본 길이
  const sendSeconds = videoSpec?.seconds?.extend && seconds != null
    ? Math.min(videoSpec.seconds.max, Math.max(baseSeconds, seconds)) : baseSeconds;
  const bitrateKey = videoSpec?.bitrate ? (m.params.find((p) => p.name === "bitrate_mode")?.enum ?? []).join("|") : "";
  const [bitrate, setBitrate] = useState("high"); // 힉스필드 웹·생성창과 같은 처음 값
  const bitrateValues = useMemo(() => (bitrateKey ? bitrateKey.split("|") : []), [bitrateKey]);
  const bitrateSend = bitrateValues.includes(bitrate) ? bitrate : bitrateValues[0];
  const audioParam = !!videoSpec?.audio && m.params.some((p) => p.name === "generate_audio");
  const [audio, setAudio] = useState(true);
  const editParams = useMemo(() => {
    if (!isVideo) return { ...(aspect ? { aspect_ratio: aspect } : {}), ...(imageResolution ? { resolution: imageResolution } : {}) };
    return {
      ...videoSpec?.fixed,
      ...(optionName && option ? { [optionName]: option } : {}),
      ...(videoSpec?.seconds && sendSeconds ? { duration: sendSeconds } : {}),
      ...(bitrateSend ? { bitrate_mode: bitrateSend } : {}),
      ...(audioParam ? { generate_audio: audio } : {}),
    };
  }, [isVideo, aspect, imageResolution, videoSpec, optionName, option, sendSeconds, bitrateSend, audioParam, audio]);
  const [cost, setCost] = useState<number | null>(null);
  const [successfulCostKey, setSuccessfulCostKey] = useState("");
  const [costLoading, setCostLoading] = useState(false);
  const editCostKey = JSON.stringify([m.model, editParams]);
  const costSelection = useRef("");
  useEffect(() => {
    const key = editCostKey;
    if (costSelection.current !== key) { costSelection.current = key; setCost(null); }
    if (!m.model || !paramsReady || isVideo && (!videoDuration || !!optionName && !optionValues.includes(option))) {
      setCostLoading(false);
      return;
    }
    let alive = true;
    setCostLoading(true);
    sharedCostEstimate(m.model, editParams)
      .then(async (r) => {
        if (alive) { setCost(r.credits); setSuccessfulCostKey(key); }
        if (r.stale) {
          const fresh = await sharedCostEstimate(m.model, editParams, "", true);
          if (alive) { setCost(fresh.credits); setSuccessfulCostKey(key); }
        }
      }).catch(() => {}).finally(() => { if (alive) setCostLoading(false); });
    return () => {
      alive = false;
    };
  }, [m.model, paramsReady, editParams, isVideo, videoDuration, optionName, optionValues, option, editCostKey]);
  const costKnown = cost != null && (!isVideo || successfulCostKey === editCostKey);
  // 모델·옵션 칩의 목록, 색·굵기 창 — 바깥을 누르면 닫는다(생성창 칩과 같다)
  const [menu, setMenu] = useState<null | "model" | "option" | "bitrate" | "duration">(null);
  const chipsRef = useRef<HTMLDivElement>(null);
  useOutsideMouseDown(chipsRef, () => setMenu(null), menu !== null);
  const [colorOpen, setColorOpen] = useState(false);
  const dockRef = useRef<HTMLDivElement>(null);
  useOutsideMouseDown(dockRef, () => setColorOpen(false), colorOpen);

  // ── 제출 + 폴링 ──
  const [prompt, setPrompt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [waitStopped, setWaitStopped] = useState(false); // 완료됐지만 결과 로드 실패로 감시 종료
  const runTokenRef = useRef(0);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  useEffect(() => {
    const current = resultUrl;
    return () => {
      if (current) URL.revokeObjectURL(current);
    };
  }, [resultUrl]);

  // ── 영상 수정 레퍼런스 칸 — 에셋 창·탐색기에서 놓은 이미지(생성창 트레이와 같은 부품·같은 가져오기 경로) ──
  const [extraRefs, setExtraRefs] = useState<ExtraRef[]>([]);
  const [importingRefs, setImportingRefs] = useState(0); // 탐색기 파일을 올리는 동안은 제출하지 않는다
  const refUid = useRef(0);
  const maxImages = videoSpec?.maxImages ?? 0;
  const refsEditable = isVideo && stage === "draw" && !submitting;
  const addImageRefs = (items: SpotlightAssetDragItem[], dropped = items.length) => {
    const images = items.filter((item) => item.type === "image");
    const room = Math.max(0, maxImages - 1 - extraRefs.length);
    const added = images.slice(0, room).map((item): ExtraRef => {
      const base = spotlightAssetRefBase(item);
      return { ...assetIdentityForProject(base, gen.project_id || undefined), uid: `ref-${++refUid.current}`,
        file_path: base.file_path, name: base.name, thumb: base.thumb };
    });
    if (added.length) setExtraRefs((prev) => [...prev, ...added].slice(0, Math.max(0, maxImages - 1)));
    const left = dropped - added.length;
    if (left > 0) {
      flashMsg(images.length > added.length
        ? `${modelLabel(m.model)} 는 그린 프레임 포함 이미지 ${maxImages}장까지입니다 — ${left}개는 넣지 않았습니다.`
        : `레퍼런스 칸에는 이미지만 넣을 수 있습니다 — ${left}개는 넣지 않았습니다.`);
    }
  };
  const importRefFiles = async (files: File[]) => {
    const images = files.filter((file) => referenceDropTypeFromFile(file) === "image");
    if (!images.length) { flashMsg("레퍼런스 칸에는 이미지만 넣을 수 있습니다."); return; }
    setImportingRefs((n) => n + 1);
    try {
      // 생성창과 같이 이 PC 설치 폴더(imports)에 저장한다 — 놓은 파일은 Assets 에도 남는다.
      const res = await api.uploadReferenceFiles(images, { target_project_id: gen.project_id || undefined,
        target_workspace_id: workspace.id || undefined });
      const saved: SpotlightAssetDragItem[] = res.saved || [];
      notifySpotlightAssetsChanged(saved);
      if (mountedRef.current) addImageRefs(saved, files.length);
    } catch (e) {
      if (mountedRef.current) setError(`레퍼런스 이미지 가져오기 실패: ${String(e)}`);
    } finally {
      if (mountedRef.current) setImportingRefs((n) => n - 1);
    }
  };
  const onRefDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes(DRAG_TYPES.asset) || dataTransferHasFiles(e.dataTransfer)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = refsEditable ? "copy" : "none";
    }
  };
  const onRefDrop = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes(DRAG_TYPES.asset)) {
      e.preventDefault();
      if (refsEditable) addImageRefs(parseSpotlightAssetItems(readSpotlightAssetPayload(e.dataTransfer)));
    } else if (dataTransferHasFiles(e.dataTransfer)) {
      e.preventDefault(); // 막지 않으면 브라우저가 파일을 새 탭으로 연다
      if (refsEditable) void importRefFiles(filesFromDataTransfer(e.dataTransfer));
    }
  };
  const tooManyRefs = isVideo && extraRefs.length + 1 > maxImages;

  // 그린 획·친 프롬프트는 이 창의 상태에만 있다 — 그동안 창을 닫거나 새로고침하면 브라우저가 묻는다(56회차). 보낸 뒤는 서버에 있다.
  const drafting = stage === "draw" && (items.length > 0 || !!prompt.trim());
  useEffect(() => {
    holdUnload("partial-edit", drafting);
    return () => holdUnload("partial-edit", false);
  }, [drafting]);

  const workspaceReady = isGenerationWorkspaceReady(workspace);
  // 스키마 필수 — 파라미터 로드 실패로 빈 스키마가 되면 기본 1:1 로 심하게 크롭된
  // 유료 결과가 나온다(코덱스 WARN). 이미지는 비율도 필수. 주석은 선택사항(프롬프트만으로도 편집 가능 — 웹과 동일).
  const canSubmit =
    stage === "draw" &&
    !submitting &&
    !frameLoading &&
    !playing &&
    !!src &&
    !!prompt.trim() &&
    !!m.model &&
    paramsReady &&
    (isVideo || !!aspect) &&
    (!isVideo || videoDuration > 0 && (!optionName || optionValues.includes(option))) &&
    (!isVideo || successfulCostKey === editCostKey && cost !== null && Number.isFinite(cost)) &&
    importingRefs === 0 && !tooManyRefs &&
    !blockedMessage &&
    workspaceReady && openingWorkspace.current === JSON.stringify([workspace.scope, workspace.id]) &&
    isOperationContextCurrent(openingContext.current);

  // 감시용 요청의 타임아웃 — 응답이 실패도 성공도 아닌 채 영영 pending 이면 다음 틱이
  // 안 돈다(무응답 행). AbortController 로 요청 자체를 끊어 pending 누적도 막는다(코덱스).
  const abortRef = useRef<AbortController | null>(null);
  const timedFetch = async <T,>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const timer = window.setTimeout(() => ctrl.abort(), ms);
    try {
      return await run(ctrl.signal);
    } finally {
      window.clearTimeout(timer);
      if (abortRef.current === ctrl) abortRef.current = null; // 새 컨트롤러를 지우지 않게 가드
    }
  };

  const startPolling = (genId: string) => {
    const token = ++runTokenRef.current;
    abortRef.current?.abort(); // 이전 감시의 걸린 요청 정리
    const startedAt = Date.now();
    let resultAttempts = 0; // 완료된 결과의 다운로드/디코드 실패 — 영구 재다운로드 방지 상한
    const tick = async () => {
      if (token !== runTokenRef.current) return;
      try {
        const g = await timedFetch(15_000, (signal) => api.getGeneration(genId, { signal }));
        if (token !== runTokenRef.current) return;
        if (g.status === "failed" || g.status === "nsfw") {
          setStage("draw");
          const issue = generationIssueFor(g.status, g.error, g.execution_phase);
          setError(
            issue
              ? `${issue.title} — ${issue.detail}\n${issue.action}`
              : g.status === "nsfw"
              ? "생성이 NSFW 로 차단되었습니다."
              : `생성 실패: ${g.error || "원인 미상 — 라이브러리 카드를 확인하세요"}`,
          );
          return;
        }
        const done = g.status === "done" ? g.assets?.[0] : null;
        if (done?.file_path && done.type === mode) {
          // 완료됐는데 결과를 못 가져오는 건 '재생성할 일'이 아니다 — draw 로 돌리면
          // 이미 완료된 잡을 중복 생성하게 유도한다(코덱스 WARN). 몇 번 재시도 후
          // 감시 화면에 안내만 남긴다(카드는 라이브러리에 있다).
          resultAttempts++;
          try {
            const blob = await timedFetch(60_000, (signal) =>
              fetchBlob(done.file_path, isVideo ? "edit-result.mp4" : "partial-result.png", g.id, { signal }),
            );
            if (token !== runTokenRef.current) return;
            if (blob) {
              if (!isVideo) {
                const bmp = await createImageBitmap(blob);
                bmp.close();
              }
              if (token !== runTokenRef.current) return;
              setResultUrl(URL.createObjectURL(blob));
              setStage("result");
              return;
            }
          } catch {
            /* 디코드 실패 — 아래 재시도/상한 처리 */
          }
          if (token !== runTokenRef.current) return;
          if (resultAttempts >= 5) {
            runTokenRef.current++; // 감시 종료 — 재다운로드 무한 루프 방지
            setWaitStopped(true); // 감시 화면을 '완료·로드 실패 + 닫기'로 전환
            setError(
              "생성은 완료됐지만 결과를 불러오지 못했습니다 — 라이브러리 카드에서 직접 확인하세요.",
            );
            return;
          }
        }
      } catch {
        /* 일시 조회 실패 — 다음 틱에 재시도 */
      }
      if (token !== runTokenRef.current) return;
      setElapsed(Date.now() - startedAt);
      window.setTimeout(tick, POLL_MS);
    };
    void tick();
  };

  // 진짜 잉크가 남았는지 — 지우개로 전부 지운 주석으로 원본을 재인코딩·업로드하지
  // 않기 위한 검사(코덱스 WARN: 12MP 초과 원본이 불필요하게 축소 레퍼런스로 바뀜).
  // 세로 조각 단위 정확 검사, 첫 잉크에서 조기 종료. 제출 클릭 1회에만 실행.
  const annotHasInk = (): boolean => {
    const cv = annotRef.current;
    const ctx = cv?.getContext("2d");
    if (!cv || !ctx) return false;
    const stripe = 256;
    for (let y = 0; y < cv.height; y += stripe) {
      const rows = Math.min(stripe, cv.height - y);
      const data = ctx.getImageData(0, y, cv.width, rows).data;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 0) return true;
    }
    return false;
  };

  // 주석이 있으면 원본+주석 평면화 PNG 를 captures 에 업로드해 asset: 토큰 참조로,
  // 없으면 원본 URL 그대로. 업로드는 sha256 중복 재사용이라 재시도에도 파일이 늘지 않는다.
  // 업로드 후 생성이 최종 실패하면 캡처 파일 1개가 captures 에 남을 수 있다(잡 미연결) —
  // 롤백 없음은 수용(캡처는 Assets 에서 보이고 지울 수 있다, 코덱스 WARN 문서화).
  const buildReference = async (): Promise<AssetReferenceIdentity & {
    file_path: string;
    thumbnail?: string;
    discardToken?: string; // 신규 캡처에만 — 생성 요청 확정 거절(400/422) 시 고아 정리용
  }> => {
    renderAll(items); // 잉크 검사·평면화 전에 최신 스트로크 보장(undo 직후 stale 캔버스 방지)
    if (!isVideo && (!items.length || !annotHasInk())) {
      return { file_path: asset!.file_path, thumbnail: asset!.thumbnail_path || undefined };
    }
    const annot = annotRef.current;
    if (!annot || !src) throw new Error("주석 캔버스가 없습니다");
    const flat = document.createElement("canvas");
    flat.width = src.w;
    flat.height = src.h;
    const fctx = flat.getContext("2d");
    if (!fctx) throw new Error("캔버스 생성 실패");
    fctx.drawImage(src.bmp, 0, 0, src.w, src.h);
    fctx.drawImage(annot, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => flat.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("주석 이미지 인코딩 실패");
    // 주석 평면화 그림은 이 PC 설치 폴더(captures)에 저장한다(Jay 2026-09-29 옛 방식).
    const up = await api.uploadCapture(blob, { target_project_id: gen.project_id || undefined,
      target_workspace_id: workspace.id || undefined });
    return {
      ...assetIdentity(up),
      file_path: `asset:${up.project}|${up.path}`,
      thumbnail: api.assetThumbUrl(up.project, up.path, 256),
      // reused = 과거 잡이 같은 파일을 참조할 수 있음 → 정리 대상 아님(서버도 토큰 미발급)
      discardToken: up.reused ? undefined : up.discard_token,
    };
  };

  const submit = async () => {
    if (!canSubmit || !src) return;
    const operation = captureOperationContext(workspace);
    setError("");
    setSubmitting(true);
    let refBits: AssetReferenceIdentity & { file_path: string; thumbnail?: string; discardToken?: string };
    try {
      refBits = await buildReference();
    } catch (e) {
      if (mountedRef.current) {
        setSubmitting(false);
        setError(`주석 이미지 업로드 실패: ${String(e)}`);
      }
      return;
    }
    if (!mountedRef.current) return;
    if (!isOperationContextCurrent(operation) || !isOperationContextCurrent(openingContext.current) ||
      openingWorkspace.current !== JSON.stringify([workspace.scope, workspace.id])) { setSubmitting(false); return; }
    const body: GenerationCreateBody = {
      // 영상 편집 모델은 그림이 몇 초 장면인지 받는 칸이 없다 — 글로 알려 주고, 표시가 결과에 그려지지 않게 한다(10-28 시험과 같은 안내).
      prompt: isVideo
        ? `${prompt.trim()}\n${extraRefs.length ? "첫 번째 참고 이미지" : "참고 이미지"}는 원본 영상 ${frameTime.toFixed(3)}초 장면에 고칠 곳을 표시한 그림입니다. 표시(선·도형)는 결과 영상에 넣지 마세요.`
        : prompt.trim(),
      model: m.model,
      params: editParams,
      project_id: gen.project_id || undefined,
      folder_path: gen.folder_path || undefined,
      references: [
        ...(isVideo ? [{ file_path: asset!.file_path, type: "video", role: "video", source_gen_id: gen.id }] : []),
        {
          ...assetIdentity(refBits),
          file_path: refBits.file_path,
          type: "image",
          role: isVideo ? "image_references" : "@Image1",
          source_gen_id: gen.id,
          thumbnail: refBits.thumbnail,
          name: gen.source_name || undefined,
        },
        // 레퍼런스 칸 2번부터 — 그린 프레임 뒤에 칸 순서대로(같은 image_references 로 이어진다)
        ...extraRefs.map((ref) => ({ ...assetIdentity(ref), file_path: ref.file_path, type: "image", role: "image_references",
          thumbnail: ref.thumb, name: ref.name })),
      ],
    };
    // prepareCreate 클로저 = 제출 1회의 idempotency key. 답이 없을 때의 재전송은 전송 층(jsonFetch)이 같은 key·같은 헤더로
    // 한 번 한다 — 여기서 또 부르면 최대 네 번 보냈고, 새 변경 id·토큰으로 나갔다(Jay 결정 2A, Codex D5).
    const run = api.prepareCreate(body, workspace);
    let created: Generation | null = null;
    try {
      created = await run();
    } catch (e) {
      // 확정 거절(400/422)만 방금 올린 신규 캡처를 정리한다 — 4xx 는 서버에 커밋된 적이 없다는 뜻.
      // 네트워크 오류·5xx·타임아웃·408/409/429 는 커밋됐을 수 있어 절대 지우지 않는다(코덱스).
      if (refBits.discardToken && e instanceof HttpError && (e.status === 400 || e.status === 422)) {
        api.discardCapture(refBits.discardToken).catch(() => {});
      }
      if (mountedRef.current) {
        setSubmitting(false);
        setError(`생성 요청 실패: ${String(e)}`);
      }
      return;
    }
    // 계보는 references 의 source_gen_id 가 이미 만든다(서버가 reference 엣지 기록). 별도 호출 없음.
    onQueued(created); // 카드가 생겼으면 unmount 여부와 무관하게 목록에 알린다
    if (!mountedRef.current) return;
    if (CLOSE_ON_QUEUE) {
      flashMsg(`${editLabel} 요청을 보냈습니다 — 완료되면 라이브러리 카드에 나타납니다.`);
      onClose();
      return;
    }
    setSubmitting(false);
    setElapsed(0);
    setWaitStopped(false);
    setStage("wait");
    startPolling(created.id);
  };

  const stopMonitoring = () => {
    runTokenRef.current++;
    abortRef.current?.abort();
    flashMsg("감시를 중단했습니다 — 생성은 계속되며 완료되면 라이브러리 카드에 나타납니다.");
    onClose();
  };

  const [showOriginal, setShowOriginal] = useState(false); // 결과 화면에서 꾹 누르는 동안 원본
  // 비교 A/B — 세로 분할선 와이프: 마우스 x 를 따라 왼쪽=원본(A), 오른쪽=결과(B).
  const [abCompare, setAbCompare] = useState(false);
  const [splitX, setSplitX] = useState(0.5); // 0..1, 무대 폭 기준
  // 누른 채 Alt+Tab 등으로 창 포커스를 잃으면 pointerup 이 안 와 push 가 고착된다(코덱스 WARN).
  useEffect(() => {
    const reset = () => setShowOriginal(false);
    window.addEventListener("blur", reset);
    return () => window.removeEventListener("blur", reset);
  }, []);

  // ── 프레임 띠 — 편집 탭 뷰어와 같은 조작(빨간 재생헤드를 끌어 훑기·−1f/+1f·재생, ←→ Space Home End) ──
  const totalFrames = Math.max(1, Math.round(videoDuration * EDIT_FPS));
  const frameLocked = items.length > 0; // 그린 표시는 그 장면에 붙는다 — 다 지워야 다시 움직인다
  const frameTimeRef = useRef(0);
  const tcRef = useRef<HTMLSpanElement>(null);
  const frameNoRef = useRef<HTMLElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const fillRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const scrubbingRef = useRef(false);
  const captureTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(captureTimer.current), []);
  // 띠의 글자·재생헤드는 상태 없이 바로 그린다 — 끄는 동안·재생 중 매 프레임 창 전체를 다시 그리지 않게
  const paintTime = (t: number) => {
    frameTimeRef.current = t;
    if (tcRef.current) tcRef.current.textContent = timecode(t);
    if (frameNoRef.current) frameNoRef.current.textContent = String(Math.min(totalFrames, Math.round(t * EDIT_FPS) + 1));
    const at = `${videoDuration > 0 ? Math.min(100, Math.max(0, (t / videoDuration) * 100)) : 0}%`;
    if (headRef.current) headRef.current.style.left = at;
    if (fillRef.current) fillRef.current.style.width = at;
  };
  useEffect(() => paintTime(frameTime), [frameTime, videoDuration]); // eslint-disable-line react-hooks/exhaustive-deps
  // commit=false 는 끄는 중 — 화면만 옮기고, 놓을 때(commit) 그 장면을 그림으로 뜬다(평면화·비율용).
  const seekTo = (time: number, commit = true) => {
    const video = sourceVideoRef.current;
    if (!video || frameLocked || stage !== "draw") return;
    if (!video.paused) video.pause();
    setPlaying(false);
    const t = Math.min(Math.max(0, time), Math.max(0, videoDuration - 1 / EDIT_FPS));
    video.currentTime = t;
    paintTime(t);
    if (!commit) return;
    setFrameTime(t);
    ++frameTicket.current; // 앞서 뜨던 장면은 버린다
    setFrameLoading(true);
    window.clearTimeout(captureTimer.current);
    captureTimer.current = window.setTimeout(() => void captureFrame(video, t), 120);
  };
  const togglePlay = () => {
    const video = sourceVideoRef.current;
    if (!video || frameLocked || stage !== "draw") return;
    if (!video.paused) {
      seekTo(video.currentTime); // 멈춘 자리를 확정하고 그 장면을 뜬다
      return;
    }
    if (video.currentTime >= videoDuration - 1 / EDIT_FPS) video.currentTime = 0;
    setPlaying(true);
    void video.play().catch(() => setPlaying(false));
  };
  useEffect(() => {
    const video = sourceVideoRef.current;
    if (!playing || !video) return;
    let raf = 0;
    const paint = () => paintTime(video.currentTime);
    const loop = () => {
      paint();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    // 창이 뒤에 있으면 rAF 가 멈춘다 — 영상 자체의 시간 알림으로도 띠를 따라가게(초당 몇 번)
    video.addEventListener("timeupdate", paint);
    return () => {
      cancelAnimationFrame(raf);
      video.removeEventListener("timeupdate", paint);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);
  const scrubTime = (e: React.PointerEvent) => {
    const box = trackRef.current?.getBoundingClientRect();
    return box && box.width ? videoDuration * Math.min(1, Math.max(0, (e.clientX - box.left) / box.width)) : null;
  };

  // 키보드 — Esc 닫기(제출 요청 중·감시 중 금지: 제출 중 닫고 다시 열면 새 idempotency
  // key 로 유료 요청이 이중 생성, 코덱스 BLOCK) + 그리기 단축키(Ctrl+Z 실행취소·Ctrl+Shift+Z/Ctrl+Y 다시,
  // [ ] 크기, D 펜 / E 지우개 / R 도형 — 웹 편집기와 동일 키) + 영상 프레임(←→ 한 프레임·Space 재생·Home End).
  // 입력창에 포커스가 있으면 그리기 단축키는 양보한다(텍스트 undo·괄호 입력 보존).
  const closable = stage !== "wait" && !submitting;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return; // 아래 useEscapeClose 가 맡는다
      const t = e.target instanceof Element ? e.target : null;
      if (t?.closest("textarea, input, select, [contenteditable]")) return;
      if (stage !== "draw") return;
      const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
      // 여기서 처리한 키는 뒤 캔버스(useSceneKeyboardShortcuts, window 버블)로 흘리지 않는다 —
      // 주석 한 획을 지웠는데 캔버스의 직전 편집까지 같이 취소됐다(코덱스 레인B P1).
      // capture 단계 리스너라 stopPropagation 이 같은 window 의 버블 리스너를 막는다.
      // 입력창 포커스는 위에서 먼저 양보하므로 텍스트 undo·괄호 입력은 그대로다.
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && (k === "z" || k === "y")) {
        e.preventDefault();
        e.stopPropagation();
        // Shift 를 가려 받는다 — 전엔 다시 하려던 Ctrl+Shift+Z 가 획을 하나 더 지웠다(조작 규칙 44).
        if (!e.altKey) (k === "y" || e.shiftKey ? redoStroke : undoStroke)();
      } else if (isVideo && plain && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        e.stopPropagation();
        seekTo(frameTimeRef.current + (e.key === "ArrowRight" ? 1 : -1) / EDIT_FPS);
      } else if (isVideo && plain && e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        togglePlay();
      } else if (isVideo && plain && (e.key === "Home" || e.key === "End")) {
        e.preventDefault();
        e.stopPropagation();
        seekTo(e.key === "Home" ? 0 : videoDuration);
      } else if (e.key === "[") {
        e.stopPropagation();
        setBrushSize((s) => Math.max(4, s - 8));
      } else if (e.key === "]") {
        e.stopPropagation();
        setBrushSize((s) => Math.min(120, s + 8));
      } else if (plain && e.key.toLowerCase() === "d") {
        e.stopPropagation();
        setTool("pen");
      } else if (plain && e.key.toLowerCase() === "e") {
        e.stopPropagation();
        setTool("erase");
      } else if (plain && e.key.toLowerCase() === "r") {
        e.stopPropagation();
        setTool("shape");
      } else if (plain && e.key.toLowerCase() === "t") {
        e.stopPropagation();
        setTool("text");
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
    // 획·다시 목록·재생 상태가 바뀌면 새 값으로 다시 건다(되돌리기·다시·프레임 이동이 지금 값을 쓰게)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, items, redo, playing, videoDuration]);
  // 닫을 수 없는 동안(제출 요청 중·감시 중)에도 Esc 는 이 창이 갖는다 — 뒤 화면으로 새지 않는다.
  // Esc 로는 창을 닫지 않는다(Jay 2026-10-28) — 그린 것·쓴 지시가 한 번에 날아가지 않게. 닫기는 X 나 생성으로만.
  //  Esc 는 이 창이 갖고(뒤 화면으로 새지 않게), 쓰던 글자 → 굵기 숫자 입력 → 열린 목록 → 색 창 순서로 하나씩만 닫는다.
  useEscapeClose(
    () => {
      if (textDraftRef.current) {
        textDraftRef.current = null;
        setTextDraft(null);
      } else if (sizeText !== null) {
        setSizeText(null);
      } else if (menu) {
        setMenu(null);
      } else if (colorOpen) {
        setColorOpen(false);
      }
    },
    true,
    true,
    true,
  );
  // 초점을 창(뿌리)에 둔다 — 입력칸이 아니라 뿌리라 그리기 단축키는 전처럼 먹는다(lib/keyGate '모달의 초점').
  const modalRef = useRef<HTMLDivElement>(null);
  useModalFocus(modalRef);

  const slow = elapsed > SLOW_AFTER_MS;
  // 비율 보존 무대 크기 — 높이 상한(62vh, 영상은 위아래 띠 자리만큼 50vh)을 비율로 폭 상한에 옮겨, 어느 축이
  // 클램프돼도 상자 비율 = 이미지 비율(주석 좌표 매핑의 전제)이 유지된다. 50vh = 1500×980 창에서 Generate 까지 한 화면(10-28 실측).
  const stageStyle = src
    ? {
        aspectRatio: `${src.w} / ${src.h}`,
        width: "min(86vw, 1380px)",
        // 영상은 아래 레퍼런스 칸(약 106px)·두 줄 안내만큼 더 줄인다 — 1500×980 창에서 스크롤 없이 Generate 까지(10-28 실측)
        maxWidth: `calc(${isVideo ? "(50vh - 124px)" : "62vh"} * ${(src.w / src.h).toFixed(6)})`,
      }
    : undefined;
  return (
    <div className="partial-edit-backdrop">
      <div ref={modalRef} className="partial-edit-modal" role="dialog" aria-modal="true" aria-label={editLabel}>
        <header className="partial-edit-head">
          <span className="partial-edit-title">{isVideo ? <VideoEditIcon /> : <ImageEditIcon />}{editLabel}</span>
          <span className="partial-edit-sub">
            {isVideo ? "고칠 프레임을 고르고 펜·도형으로 표시한 뒤 지시" : "펜·도형으로 표시하고 지시"} — 그린 표시는 모델에게 그대로 보입니다
          </span>
          {closable && (
            <button className="assets-x" onClick={onClose} title="닫기">
              <CloseIcon />
            </button>
          )}
        </header>

        {error && <div className="partial-edit-error">{error}</div>}
        {note && <div className="partial-edit-note">{note}</div>}

        {stage === "load" && <div className="partial-edit-loading">원본 불러오는 중…</div>}
        {(stage === "draw" || stage === "wait") && src && (
          <>
            <div className={isVideo ? "pe-viewer" : "pe-plain"}>
            {isVideo && (
              <div className="pe-vtop">
                <span className="pe-vtc" ref={tcRef}>{timecode(frameTime)}</span>
                <span className="pe-vlabel">수정할 프레임 <b ref={frameNoRef}>{Math.min(totalFrames, Math.round(frameTime * EDIT_FPS) + 1)}</b> / {totalFrames}</span>
                {frameLocked && <span className="pe-lock">🔒 그린 표시가 있어 프레임 고정 — 전체 지우기로 풀림</span>}
                <span className="pe-vtc pe-vtotal">{timecode(videoDuration)}</span>
              </div>
            )}
            <div className="partial-edit-stagebox" style={stageStyle}>
              {isVideo ? (
                // 원본 영상 요소를 그대로 붙인다 — 끄는 동안 브라우저가 바로 그 장면을 그린다(그림 뜨기는 멈춘 뒤에만)
                <div className="pe-vhost" ref={(el) => {
                  const video = sourceVideoRef.current;
                  if (el && video && video.parentElement !== el) el.appendChild(video);
                }} />
              ) : <img src={srcUrlRef.current} alt="" draggable={false} />}
              <canvas
                ref={(el) => {
                  annotRef.current = el;
                  if (el && (el.width !== src.w || el.height !== src.h)) {
                    el.width = src.w;
                    el.height = src.h;
                    renderAll(items);
                  }
                }}
                className={stage === "draw" ? "is-drawing" + (tool === "text" ? " is-text" : "") : ""}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerEnter={trackCursor}
                onPointerLeave={onPointerLeave}
                onPointerUp={endStroke}
                onPointerCancel={cancelStroke}
                onLostPointerCapture={cancelStroke}
              />
              {/* 펜 크기 미리보기 원(선택 색) — 지우개는 흰 점선, 도형은 crosshair 만 */}
              <div ref={cursorRef} className="partial-edit-cursor" />
              {/* 글자 입력칸 — 누른 자리에 뜬다. Enter·바깥 누름 = 확정, Esc = 이 글자만 취소 */}
              {textDraft && stage === "draw" && (
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
              )}
              {stage === "wait" && (
                <div className="partial-edit-waitveil">
                  {waitStopped ? (
                    <>
                      <div>생성은 완료 — 결과 이미지를 불러오지 못했습니다.</div>
                      <button className="settings-action ghost" onClick={onClose}>
                        닫기 (카드는 라이브러리에 있음)
                      </button>
                    </>
                  ) : (
                    <>
                      <div>
                        생성 중… {Math.round(elapsed / 1000)}초
                        {slow && (
                          <div className="partial-edit-slow">
                            오래 걸리고 있습니다 — 라이브러리 카드로도 진행을 확인할 수 있습니다.
                          </div>
                        )}
                      </div>
                      <button className="settings-action ghost" onClick={stopMonitoring}>
                        감시 중단 (생성은 계속됨)
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
            {isVideo && (
              <div className="pe-vbot">
                {/* 타임바 — 누르거나 끌어서 훑는다(편집 탭 뷰어와 같은 모양). 끄는 동안은 영상만 옮기고, 놓으면 그 장면을 뜬다. */}
                <div className="pe-scrub" role="slider" aria-label="수정할 영상 시점" aria-valuemin={0}
                  aria-valuemax={Number(videoDuration.toFixed(3))} aria-valuenow={Number(frameTime.toFixed(3))}
                  aria-disabled={frameLocked || stage !== "draw"}
                  onPointerDown={(e) => {
                    if (e.button !== 0 || frameLocked || stage !== "draw") return;
                    scrubbingRef.current = true;
                    e.currentTarget.setPointerCapture?.(e.pointerId);
                    const time = scrubTime(e);
                    if (time != null) seekTo(time, false);
                  }}
                  onPointerMove={(e) => {
                    if (!scrubbingRef.current) return;
                    const time = scrubTime(e);
                    if (time != null) seekTo(time, false);
                  }}
                  onPointerUp={() => {
                    if (!scrubbingRef.current) return;
                    scrubbingRef.current = false;
                    seekTo(frameTimeRef.current);
                  }}
                  onPointerCancel={() => {
                    if (!scrubbingRef.current) return;
                    scrubbingRef.current = false;
                    seekTo(frameTimeRef.current);
                  }}>
                  <div className="pe-scrub-track" ref={trackRef}>
                    <div className="pe-scrub-fill" ref={fillRef} />
                    <div className="pe-scrub-head" ref={headRef} />
                  </div>
                </div>
                <div className="pe-trans">
                  <span className="pe-keys">← → 한 프레임 · Space 재생</span>
                  <button type="button" className="pe-tbtn" title="처음으로 (Home)" aria-label="처음으로" disabled={frameLocked || stage !== "draw"}
                    onClick={() => seekTo(0)}>
                    <svg width="16" height="14" viewBox="0 0 16 14" aria-hidden="true"><rect x="1" y="1" width="2" height="12" /><path d="M15 1v12L5 7z" /></svg>
                  </button>
                  <button type="button" className="pe-tbtn pe-step" title="한 프레임 뒤로 (←)" aria-label="한 프레임 뒤로" disabled={frameLocked || stage !== "draw"}
                    onClick={() => seekTo(frameTimeRef.current - 1 / EDIT_FPS)}>−1f</button>
                  <button type="button" className="pe-tbtn pe-play" title="재생/정지 (Space)" aria-label="재생/정지" disabled={frameLocked || stage !== "draw"}
                    onClick={togglePlay}>
                    {playing
                      ? <svg width="12" height="14" viewBox="0 0 12 14" aria-hidden="true"><rect x="1.5" y="1" width="3.2" height="12" /><rect x="7.3" y="1" width="3.2" height="12" /></svg>
                      : <svg width="12" height="14" viewBox="0 0 12 14" aria-hidden="true"><path d="M2 1v12l9-6z" /></svg>}
                  </button>
                  <button type="button" className="pe-tbtn pe-step" title="한 프레임 앞으로 (→)" aria-label="한 프레임 앞으로" disabled={frameLocked || stage !== "draw"}
                    onClick={() => seekTo(frameTimeRef.current + 1 / EDIT_FPS)}>+1f</button>
                  <button type="button" className="pe-tbtn" title="끝으로 (End)" aria-label="끝으로" disabled={frameLocked || stage !== "draw"}
                    onClick={() => seekTo(videoDuration)}>
                    <svg width="16" height="14" viewBox="0 0 16 14" aria-hidden="true"><rect x="13" y="1" width="2" height="12" /><path d="M1 1v12l10-6z" /></svg>
                  </button>
                </div>
              </div>
            )}
            </div>
            {stage === "draw" && (
              <>
                {/* 도구 — 그림·영상 바로 밑 가운데 한 줄 캡슐(힉스필드 편집기처럼, Jay 2026-10-28 시안 4차).
                    색·굵기는 색 단추를 눌러 여는 작은 창에. */}
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
                {/* 프롬프트·모델·Generate — 생성창 프롬프트 판과 같은 부품(.sl-*, prompt-dock.css 는 전역).
                    autoFocus 없음: 기본은 그리기 모드(단축키 유지), 입력은 클릭해야 시작 */}
                <div className="sl-panel pe-prompt" onDragOver={isVideo ? onRefDragOver : undefined} onDrop={isVideo ? onRefDrop : undefined}>
                  {isVideo && (
                    <div className="sl-reftray" aria-label="레퍼런스">
                      <div className="sl-reftray-scroll">
                        <div className="sl-reftray-item" title="1. 그린 프레임 — 자동으로 들어갑니다(뺄 수 없음)">
                          <span className="sl-reftray-num">1</span>
                          {srcUrlRef.current ? <img src={srcUrlRef.current} alt="" draggable={false} /> : <span className="sl-reftray-ph" />}
                          <span className="sl-reftray-name">그린 프레임</span>
                          <span className="sl-reftray-linked">🔒</span>
                        </div>
                        {extraRefs.map((ref, index) => (
                          <div key={ref.uid} className="sl-reftray-item" title={`${index + 2}. ${ref.name}`}>
                            <span className="sl-reftray-num">{index + 2}</span>
                            <img src={ref.thumb} alt="" draggable={false} />
                            <span className="sl-reftray-name">{ref.name}</span>
                            <button type="button" className="sl-reftray-x" title="빼기" aria-label={`${index + 2}번 레퍼런스 빼기`}
                              disabled={!refsEditable} onMouseDown={(e) => e.preventDefault()}
                              onClick={() => setExtraRefs((prev) => prev.filter((item) => item.uid !== ref.uid))}>×</button>
                          </div>
                        ))}
                        <div className="sl-reftray-empty pe-refhint">
                          <span>
                            에셋 창 또는 탐색기에서 이미지를 여기로 드래그하세요 - 번호 순서대로 레퍼런스가 됩니다<br />
                            <b>이미지 {extraRefs.length + 1} / 최대 {maxImages}장</b> (그린 프레임 포함)
                            {importingRefs > 0 && " · 가져오는 중…"}
                          </span>
                        </div>
                      </div>
                    </div>
                  )}
                  <div className="sl-prompt-row">
                    <textarea
                      className="sl-prompt"
                      rows={2}
                      aria-label="수정 지시"
                      placeholder={`${isVideo ? "영상을" : "이미지를"} 어떻게 수정할까요? — 클릭해서 입력`}
                      value={prompt}
                      onChange={(e) => setPrompt(e.target.value)}
                      onKeyDown={(e) => {
                        // IME 조합 중 Enter(한글 마지막 글자 확정)는 제출이 아니다 — 미완성
                        // 프롬프트로 유료 생성이 시작된다(코덱스 BLOCK). keyCode 229 = Chromium IME.
                        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          void submit();
                        }
                      }}
                    />
                    <button type="button" className="sl-prompt-clear" title="프롬프트 비우기" aria-label="프롬프트 비우기"
                      onMouseDown={(e) => e.preventDefault()} onClick={() => setPrompt("")}>
                      <EraserIcon />
                    </button>
                    <button type="button" className="sl-copy-btn" title="프롬프트 전체 복사" aria-label="프롬프트 전체 복사"
                      onMouseDown={(e) => e.preventDefault()} onClick={() => void copyText(prompt)}>
                      <CopyIcon />
                    </button>
                  </div>
                  <div className="sl-controls" ref={chipsRef}>
                    <div className="sl-left">
                      <div className="sl-chip-wrap">
                        <button type="button" className={"sl-chip" + (menu === "model" ? " active" : "")} title="수정 모델" aria-label="수정 모델"
                          aria-haspopup="listbox" aria-expanded={menu === "model"} disabled={submitting}
                          onClick={() => setMenu(menu === "model" ? null : "model")}>
                          <span className="sl-dot" />
                          <span className="sl-chip-label">{modelLabel(m.model)}</span>
                          <span className="sl-caret">›</span>
                        </button>
                        {menu === "model" && (
                          <div className="sl-dropdown pe-menu" role="listbox" aria-label="수정 모델">
                            <div className="sl-dd-title">{isVideo ? "Video" : "Image"} Model</div>
                            <div className="sl-dd-scroll">
                              {editModels.map((id) => {
                                const allowed = modelAllowed(modelPolicy, id);
                                return (
                                  <button key={id} type="button" role="option" aria-selected={id === m.model} disabled={!allowed}
                                    className={"sl-dd-item pe-dd-item" + (id === m.model ? " sel" : "") + (allowed ? "" : " blocked")}
                                    onClick={() => { m.setModel(id); setMenu(null); }}>
                                    {modelLabel(id)}
                                    {id === editModels[0] && <span className="pe-tag">기본</span>}
                                    {!allowed && <span className="sl-dd-lock"> 🔒</span>}
                                  </button>
                                );
                              })}
                            </div>
                            {editModels.some((id) => !modelAllowed(modelPolicy, id)) && (
                              <div className="sl-dd-note">🔒 = 이 그룹의 '사용 모델'에 없음</div>
                            )}
                          </div>
                        )}
                      </div>
                      {optionName && optionValues.length > 0 && (
                        <div className="sl-chip-wrap">
                          <button type="button" className={"sl-chip sl-opt-chip" + (menu === "option" ? " active" : "")}
                            title={optionName === "mode" ? "영상 수정 품질" : "영상 수정 해상도"} aria-label={optionName === "mode" ? "영상 수정 품질" : "영상 수정 해상도"}
                            aria-haspopup="listbox" aria-expanded={menu === "option"} disabled={submitting}
                            onClick={() => setMenu(menu === "option" ? null : "option")}>
                            <span className="sl-opt-ic"><SpotlightOptionIcon name="resolution" /></span>
                            {/* 값 칸 = 가장 긴 값만큼 — 값을 바꿔도 칩 폭이 그대로(생성창과 같은 규칙, Jay 2026-10-28) */}
                            <span className="sl-opt-text" style={{ minWidth: `${Math.max(...optionValues.map((v) => optionLabel(v).length)) + 0.5}ch` }}>{optionLabel(option)}</span>
                            <span className="sl-caret">›</span>
                          </button>
                          {menu === "option" && (
                            <div className="sl-dropdown pe-menu-small" role="listbox" aria-label={optionName === "mode" ? "영상 수정 품질" : "영상 수정 해상도"}>
                              <div className="sl-dd-title">Quality</div>
                              <div className="sl-dd-scroll">
                                {optionValues.map((value) => (
                                  <button key={value} type="button" role="option" aria-selected={value === option}
                                    className={"sl-dd-item" + (value === option ? " sel" : "")}
                                    onClick={() => { setOption(value); setMenu(null); }}>
                                    {optionLabel(value)}
                                  </button>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                      {bitrateValues.length > 0 && (
                        <div className="sl-chip-wrap">
                          {/* 칩엔 아이콘+값만 — '비트레이트' 글자는 빼고 마우스를 올리면 뜬다(Jay 2026-10-28, 다른 칩과 같게) */}
                          <button type="button" className={"sl-chip sl-opt-chip" + (menu === "bitrate" ? " active" : "")}
                            title="비트레이트" aria-label="비트레이트" aria-haspopup="listbox" aria-expanded={menu === "bitrate"}
                            disabled={submitting} onClick={() => setMenu(menu === "bitrate" ? null : "bitrate")}>
                            <span className="sl-opt-ic"><SpotlightOptionIcon name="bitrate_mode" /></span>
                            <span className="sl-opt-text" style={{ minWidth: `${Math.max(...bitrateValues.map((v) => v.length)) + 0.5}ch` }}>{bitrateLabel(bitrateSend)}</span>
                            <span className="sl-caret">›</span>
                          </button>
                          {menu === "bitrate" && (
                            <div className="sl-dropdown pe-menu-small" role="listbox" aria-label="비트레이트">
                              <div className="sl-dd-title">Bitrate</div>
                              <div className="sl-dd-scroll">
                                {bitrateValues.map((value) => (
                                  <button key={value} type="button" role="option" aria-selected={value === bitrateSend}
                                    className={"sl-dd-item" + (value === bitrateSend ? " sel" : "")}
                                    onClick={() => { setBitrate(value); setMenu(null); }}>
                                    {bitrateLabel(value)}
                                  </button>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                      {audioParam && (
                        <div className="sl-chip sl-opt-audio" title="소리 만들기 (켜기/끄기)">
                          <span className="sl-opt-ic"><SpotlightOptionIcon name="generate_audio" /></span>
                          <div className="sl-adv-opts">
                            <button type="button" className={"sl-adv-opt" + (audio ? " sel" : "")} aria-pressed={audio}
                              aria-label="소리 켜기" disabled={submitting} onClick={() => setAudio(true)}>ON</button>
                            <button type="button" className={"sl-adv-opt" + (audio ? "" : " sel")} aria-pressed={!audio}
                              aria-label="소리 끄기" disabled={submitting} onClick={() => setAudio(false)}>OFF</button>
                          </div>
                        </div>
                      )}
                      {videoSpec?.seconds?.extend && baseSeconds > 0 && (
                        <SpotlightDurationChip value={sendSeconds} min={baseSeconds} max={videoSpec.seconds.max} label="영상 길이"
                          title={`길이 ${baseSeconds}~${videoSpec.seconds.max}초 — 원본보다 길면 뒤로 이어 늘립니다`}
                          open={menu === "duration"} onToggle={() => setMenu(menu === "duration" ? null : "duration")}
                          onChange={setSeconds} disabled={submitting} />
                      )}
                      {isVideo && videoDuration > 0 && (
                        <div className="sl-ignored-note">
                          {videoSpec?.seconds?.extend ? (
                            <>길이 <b>{baseSeconds}초 = 원본(수정)</b> · <strong>더 길게 = 뒤로 이어 늘리기</strong>
                              {" "}— 늘어난 부분에 지시가 들어갑니다. 비율은 원본, 요금은 고른 길이로.</>
                          ) : (
                            <>길이·비율은 원본 영상을 따릅니다({Math.round(videoDuration)}초).</>
                          )}
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      className="sl-gen partial-edit-gen"
                      disabled={!canSubmit}
                      onClick={submit}
                      title={costKnown ? `${editLabel} — 예상 ${formatCredits(cost!)} 크레딧` : `${editLabel} — 견적 확인 안 됨`}
                    >
                      {submitting ? "보내는 중…" : "Generate"} <span className="sl-sparkle">✦</span>
                      {costKnown ? <span className="sl-cost partial-edit-cost">{formatCredits(cost!)}</span>
                        : costLoading ? <span className="sl-cost loading partial-edit-cost">…</span> : null}
                    </button>
                  </div>
                </div>
                {!costKnown && !costLoading && paramsReady && (
                  <div className="partial-edit-hint">
                    견적 확인 안 됨{isVideo ? " — 영상은 견적이 나와야 생성할 수 있습니다." : ""}
                  </div>
                )}
                {!workspaceReady && (
                  <div className="partial-edit-hint">워크스페이스 확인 후 생성할 수 있습니다.</div>
                )}
                {blockedMessage && <div className="partial-edit-hint">{blockedMessage}</div>}
                {tooManyRefs && (
                  <div className="partial-edit-hint">
                    {modelLabel(m.model)} 는 그린 프레임 포함 이미지 {maxImages}장까지입니다 — 레퍼런스를 {extraRefs.length + 1 - maxImages}개 빼세요.
                  </div>
                )}
                {m.paramsModel === m.model && !m.paramsLoading && (!m.params.length || !isVideo && !aspect) && (
                  <div className="partial-edit-hint">
                    모델 파라미터를 불러오지 못해 생성할 수 없습니다 — 다시 열어보세요.
                  </div>
                )}
              </>
            )}
          </>
        )}

        {stage === "result" && src && resultUrl && isVideo && (
          <>
            <video className="partial-edit-video-result" src={showOriginal ? sourceVideoUrlRef.current : resultUrl} controls preload="metadata" />
            <div className="partial-edit-tools">
              <button onClick={() => setShowOriginal((value) => !value)}>{showOriginal ? "수정 결과 보기" : "원본 영상 비교"}</button>
            </div>
          </>
        )}
        {stage === "result" && src && resultUrl && !isVideo && (
          <>
            <div
              className={"partial-edit-stagebox" + (abCompare ? " ab-active" : "")}
              style={stageStyle}
              onPointerMove={
                abCompare
                  ? (e) => {
                      const rect = e.currentTarget.getBoundingClientRect();
                      if (!rect.width) return;
                      setSplitX(Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)));
                    }
                  : undefined
              }
            >
              {/* contain — 결과 비율이 enum 스냅으로 원본과 미세하게 다르면 늘어나 보이는 대신
                  얇은 레터박스로 흡수(무대 배경은 이미 어두움, 코덱스 WARN) */}
              <img
                src={showOriginal ? srcUrlRef.current : resultUrl}
                alt=""
                draggable={false}
                style={{ objectFit: "contain" }}
              />
              {abCompare && !showOriginal && (
                <>
                  {/* 원본을 불투명 배경 wrapper 로 겹치고 wrapper 를 clip — 왼쪽=A(원본),
                      오른쪽=B(결과). 비율 차이로 레터박스가 생겨도 아래가 비치지 않는다. */}
                  <div
                    className="partial-edit-wipetop"
                    style={{ clipPath: `inset(0 ${(100 - splitX * 100).toFixed(2)}% 0 0)` }}
                  >
                    <img
                      src={srcUrlRef.current}
                      alt=""
                      draggable={false}
                      style={{ objectFit: "contain" }}
                    />
                  </div>
                  <div className="partial-edit-abline" style={{ left: `${(splitX * 100).toFixed(2)}%` }} />
                </>
              )}
              {/* 상태 뱃지 + 하단 중앙 비교 버튼(버전 비교와 동일 구성) */}
              <div className="partial-edit-ablabel">
                {showOriginal ? "원본" : abCompare ? "A 원본 · 결과 B" : "결과"}
              </div>
              <div className="partial-edit-abbtns">
                <button
                  className={showOriginal ? "on" : ""}
                  title="누르고 있는 동안 원본 표시"
                  onPointerDown={() => setShowOriginal(true)}
                  onPointerUp={() => setShowOriginal(false)}
                  onPointerLeave={() => setShowOriginal(false)}
                  onPointerCancel={() => setShowOriginal(false)}
                >
                  비교 push
                </button>
                <button
                  className={abCompare ? "on" : ""}
                  title="마우스를 좌우로 움직여 분할선 비교 — 왼쪽 원본 / 오른쪽 결과"
                  onClick={() => {
                    setAbCompare((v) => !v);
                    setSplitX(0.5);
                  }}
                >
                  비교 A/B
                </button>
              </div>
            </div>
            <div className="partial-edit-tools">
              <span className="partial-edit-toolspacer" />
              <button
                className="settings-action ghost"
                onClick={() => {
                  setResultUrl(null);
                  setAbCompare(false);
                  setShowOriginal(false);
                  setStage("draw");
                }}
              >
                같은 주석으로 다시 수정
              </button>
              <span className="partial-edit-toolspacer" />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
