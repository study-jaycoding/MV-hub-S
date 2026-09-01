// 부분 수정 모달 — 힉스필드 웹 편집기와 같은 원리(2026-09-01 실측으로 확정):
// 펜·도형으로 그린 표시는 '이미지에 구워져' 모델에게 그대로 전송된다(웹 편집기의 실제 전송
// 입력 이미지에 라임 동그라미가 박혀 있음을 확인). Seedream 이 낙서를 지시로 해석해 반영하고
// 낙서 없는 전체 이미지를 돌려준다 — 마스크 파라미터도, 클라이언트 합성도 없다.
// 결과가 원본에 충실한 건 Seedream 의 재현 성질 덕분(실측 ≈93% 픽셀 일치) → 모델 고정.
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
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type GenerationCreateBody } from "../../api";
import { fetchBlob } from "../../lib/download";
import { flashMsg } from "../../lib/flash";
import { isGenerationWorkspaceReady } from "../../lib/workspaceContext";
import { useModels } from "../../lib/useModels";
import type { Generation, WorkspaceContext } from "../../types";

const MAX_WORK_PIXELS = 12_000_000; // 12MP — 주석/평면화 캔버스 동시 보유 상한
const EDIT_MODEL = "seedream_v5_pro"; // 편집 전용 고정 — 웹 편집기와 동일(원본 재현 충실, 실측)
const POLL_MS = 2_000;
const SLOW_AFTER_MS = 180_000; // 이후에도 계속 감시 — 실패 처리 아님(이중 과금 방지)

// 펜 컬러 스와치 — 웹 편집기의 구성(흰·라임·주황·빨강·민트·파랑·분홍·검정). 기본 = 라임.
const COLORS = ["#ffffff", "#bef264", "#f59e0b", "#ef4444", "#2dd4bf", "#3b82f6", "#ec4899", "#111111"];

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
type DrawItem = PenStroke | ShapeItem;

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

function drawItem(ctx: CanvasRenderingContext2D, it: DrawItem) {
  if (it.kind === "pen") drawPen(ctx, it);
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

export function PartialEditModal({
  gen,
  workspace,
  onQueued,
  onClose,
}: {
  gen: Generation;
  workspace: WorkspaceContext;
  onQueued: (g: Generation) => void;
  onClose: () => void;
}) {
  const asset = gen.assets?.[0];
  const [stage, setStage] = useState<Stage>("load");
  const [error, setError] = useState("");
  const [note, setNote] = useState(""); // 축소 작업 등 비차단 안내

  // ── 원본 로드(작업 해상도 결정) ──
  const [src, setSrc] = useState<{ bmp: ImageBitmap; w: number; h: number } | null>(null);
  const srcUrlRef = useRef<string>("");
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!asset?.file_path) {
        setError("원본 이미지가 없습니다.");
        return;
      }
      const blob = await fetchBlob(asset.file_path, "partial-src.png", gen.id);
      if (!alive) return;
      if (!blob) {
        setError("원본 이미지를 불러오지 못했습니다.");
        return;
      }
      try {
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
        if (alive) setError("원본 이미지를 해석하지 못했습니다.");
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
      if (srcUrlRef.current) URL.revokeObjectURL(srcUrlRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── 주석(펜·도형 → annot 캔버스, 표시 = 전송본) ──
  const [items, setItems] = useState<DrawItem[]>([]);
  const [tool, setTool] = useState<"pen" | "erase" | "shape">("pen");
  const [shapeKind, setShapeKind] = useState<ShapeKind>("rect");
  const [color, setColor] = useState(COLORS[1]); // 라임
  const [brushSize, setBrushSize] = useState(18); // 작업 해상도 px
  const annotRef = useRef<HTMLCanvasElement | null>(null);
  const liveRef = useRef<DrawItem | null>(null);

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
    if (!pos || !annot || !src || stage !== "draw" || tool === "shape") {
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

  // ── 모델(Seedream 고정)·비율·견적 ──
  const m = useModels(() => {});
  useEffect(() => {
    m.setType("image");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // 훅의 ALLOWED 기본선택이 같은 플러시에서 먼저 실행되고 이 effect 가 덮는다 — 카탈로그 로드 후 1회만.
  const defaultApplied = useRef(false);
  useEffect(() => {
    if (defaultApplied.current || !m.models.length) return;
    defaultApplied.current = true;
    m.setModel(EDIT_MODEL);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m.models]);
  const aspect = useMemo(() => {
    if (!src || m.paramsModel !== m.model) return null;
    return nearestAspect(m.params.find((p) => p.name === "aspect_ratio")?.enum, src.w, src.h);
  }, [src, m.params, m.paramsModel, m.model]);
  const [cost, setCost] = useState<number | null>(null);
  useEffect(() => {
    if (!m.model || m.paramsModel !== m.model) return;
    let alive = true;
    setCost(null);
    api
      .estimateCost(m.model, aspect ? { aspect_ratio: aspect } : {}, "partial edit")
      .then((r) => alive && setCost(r.credits))
      .catch(() => alive && setCost(null));
    return () => {
      alive = false;
    };
  }, [m.model, m.paramsModel, aspect]);

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

  const workspaceReady = isGenerationWorkspaceReady(workspace);
  // aspect 필수 — 파라미터 로드 실패로 빈 스키마가 되면 기본 1:1 로 심하게 크롭된
  // 유료 결과가 나온다(코덱스 WARN). 주석은 선택사항(프롬프트만으로도 편집 가능 — 웹과 동일).
  const canSubmit =
    stage === "draw" &&
    !submitting &&
    !!src &&
    !!prompt.trim() &&
    !!m.model &&
    !m.paramsLoading &&
    m.paramsModel === m.model &&
    !!aspect &&
    workspaceReady;

  const startPolling = (genId: string) => {
    const token = ++runTokenRef.current;
    const startedAt = Date.now();
    let resultAttempts = 0; // 완료된 결과의 다운로드/디코드 실패 — 영구 재다운로드 방지 상한
    const tick = async () => {
      if (token !== runTokenRef.current) return;
      try {
        const g = await api.getGeneration(genId);
        if (token !== runTokenRef.current) return;
        if (g.status === "failed" || g.status === "nsfw") {
          setStage("draw");
          setError(
            g.status === "nsfw"
              ? "생성이 NSFW 로 차단되었습니다."
              : `생성 실패: ${g.error || "원인 미상 — 라이브러리 카드를 확인하세요"}`,
          );
          return;
        }
        const done = g.status === "done" ? g.assets?.[0] : null;
        if (done?.file_path && done.type === "image") {
          // 완료됐는데 결과를 못 가져오는 건 '재생성할 일'이 아니다 — draw 로 돌리면
          // 이미 완료된 잡을 중복 생성하게 유도한다(코덱스 WARN). 몇 번 재시도 후
          // 감시 화면에 안내만 남긴다(카드는 라이브러리에 있다).
          resultAttempts++;
          try {
            const blob = await fetchBlob(done.file_path, "partial-result.png", g.id);
            if (token !== runTokenRef.current) return;
            if (blob) {
              const bmp = await createImageBitmap(blob); // 디코드 검증 — 깨진 파일이면 throw
              bmp.close();
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
  const buildReference = async (): Promise<{ file_path: string; thumbnail?: string }> => {
    renderAll(items); // 잉크 검사·평면화 전에 최신 스트로크 보장(undo 직후 stale 캔버스 방지)
    if (!items.length || !annotHasInk()) {
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
    const up = await api.uploadCapture(blob);
    return {
      file_path: `asset:${up.project}|${up.path}`,
      thumbnail: api.assetThumbUrl(up.project, up.path, 256),
    };
  };

  const submit = async () => {
    if (!canSubmit || !src) return;
    setError("");
    setSubmitting(true);
    let refBits: { file_path: string; thumbnail?: string };
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
    const body: GenerationCreateBody = {
      prompt: prompt.trim(),
      model: m.model,
      params: aspect ? { aspect_ratio: aspect } : {},
      references: [
        {
          file_path: refBits.file_path,
          type: "image",
          role: "@Image1",
          source_gen_id: gen.id,
          thumbnail: refBits.thumbnail,
          name: gen.source_name || undefined,
        },
      ],
    };
    // prepareCreate 클로저 = 제출 1회의 idempotency key. 네트워크 오류 재시도에도 같은
    // 클로저를 다시 불러 유료 요청이 중복 생성되지 않는다.
    const run = api.prepareCreate(body, workspace);
    let created: Generation | null = null;
    try {
      created = await run();
    } catch {
      try {
        created = await run(); // 1회 재시도(같은 key)
      } catch (e) {
        if (mountedRef.current) {
          setSubmitting(false);
          setError(`생성 요청 실패: ${String(e)}`);
        }
        return;
      }
    }
    // 계보는 references 의 source_gen_id 가 이미 만든다(서버가 reference 엣지 기록). 별도 호출 없음.
    onQueued(created); // 카드가 생겼으면 unmount 여부와 무관하게 목록에 알린다
    if (!mountedRef.current) return;
    setSubmitting(false);
    setElapsed(0);
    setWaitStopped(false);
    setStage("wait");
    startPolling(created.id);
  };

  const stopMonitoring = () => {
    runTokenRef.current++;
    flashMsg("감시를 중단했습니다 — 생성은 계속되며 완료되면 라이브러리 카드에 나타납니다.");
    onClose();
  };

  const [showOriginal, setShowOriginal] = useState(false); // 결과 화면에서 꾹 누르는 동안 원본

  // 키보드 — Esc 닫기(제출 요청 중·감시 중 금지: 제출 중 닫고 다시 열면 새 idempotency
  // key 로 유료 요청이 이중 생성, 코덱스 BLOCK) + 그리기 단축키(Ctrl+Z 실행취소,
  // [ ] 크기, D 펜 / E 지우개 / R 도형 — 웹 편집기와 동일 키).
  // 입력창에 포커스가 있으면 그리기 단축키는 양보한다(텍스트 undo·괄호 입력 보존).
  const closable = stage !== "wait" && !submitting;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (closable) onClose();
        return;
      }
      const t = e.target instanceof Element ? e.target : null;
      if (t?.closest("textarea, input, select, [contenteditable]")) return;
      if (stage !== "draw") return;
      const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        setItems((p) => p.slice(0, -1));
      } else if (e.key === "[") {
        setBrushSize((s) => Math.max(4, s - 8));
      } else if (e.key === "]") {
        setBrushSize((s) => Math.min(120, s + 8));
      } else if (plain && e.key.toLowerCase() === "d") {
        setTool("pen");
      } else if (plain && e.key.toLowerCase() === "e") {
        setTool("erase");
      } else if (plain && e.key.toLowerCase() === "r") {
        setTool("shape");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closable, stage, onClose]);

  const slow = elapsed > SLOW_AFTER_MS;
  // 비율 보존 무대 크기 — 높이 상한(62vh)을 비율로 폭 상한에 옮겨, 어느 축이 클램프돼도
  // 상자 비율 = 이미지 비율(주석 좌표 매핑의 전제)이 유지된다.
  const stageStyle = src
    ? {
        aspectRatio: `${src.w} / ${src.h}`,
        width: "min(86vw, 1380px)",
        maxWidth: `calc(62vh * ${(src.w / src.h).toFixed(6)})`,
      }
    : undefined;
  return (
    <div className="partial-edit-backdrop">
      <div className="partial-edit-modal" role="dialog" aria-modal="true" aria-label="부분 수정">
        <header className="partial-edit-head">
          <span className="partial-edit-title">🖌 부분 수정</span>
          <span className="partial-edit-sub">
            펜·도형으로 표시하고 지시 — 그린 표시는 모델에게 그대로 보입니다
          </span>
          {closable && (
            <button className="assets-x" onClick={onClose} title="닫기">
              ✕
            </button>
          )}
        </header>

        {error && <div className="partial-edit-error">{error}</div>}
        {note && <div className="partial-edit-note">{note}</div>}

        {stage === "load" && <div className="partial-edit-loading">원본 불러오는 중…</div>}

        {(stage === "draw" || stage === "wait") && src && (
          <>
            <div className="partial-edit-stagebox" style={stageStyle}>
              <img src={srcUrlRef.current} alt="" draggable={false} />
              <canvas
                ref={(el) => {
                  annotRef.current = el;
                  if (el && (el.width !== src.w || el.height !== src.h)) {
                    el.width = src.w;
                    el.height = src.h;
                    renderAll(items);
                  }
                }}
                className={stage === "draw" ? "is-drawing" : ""}
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
            {stage === "draw" && (
              <>
                {/* 도구별 옵션 — 펜/도형이면 색, 도형이면 종류까지(웹 편집기의 팝오버 열) */}
                {tool !== "erase" && (
                  <div className="partial-edit-subtools">
                    {tool === "shape" && (
                      <>
                        {(
                          [
                            ["line", "─", "선"],
                            ["arrow", "→", "화살표"],
                            ["rect", "▢", "사각형"],
                            ["ellipse", "◯", "원"],
                          ] as [ShapeKind, string, string][]
                        ).map(([kind, icon, label]) => (
                          <button
                            key={kind}
                            className={shapeKind === kind ? "on" : ""}
                            title={label}
                            onClick={() => setShapeKind(kind)}
                          >
                            {icon}
                          </button>
                        ))}
                        <span className="partial-edit-subdiv" />
                      </>
                    )}
                    {COLORS.map((c) => (
                      <button
                        key={c}
                        className={"partial-edit-swatch" + (color === c ? " sel" : "")}
                        style={{ background: c }}
                        title={c}
                        onClick={() => setColor(c)}
                      />
                    ))}
                  </div>
                )}
                <div className="partial-edit-tools">
                  <button disabled={!items.length} onClick={() => setItems([])}>
                    전체 지우기
                  </button>
                  <span className="partial-edit-toolspacer" />
                  <label title="단축키 [ ] 로도 조절">
                    Size
                    <input
                      type="range"
                      min={4}
                      max={120}
                      value={brushSize}
                      onChange={(e) => setBrushSize(Number(e.target.value))}
                    />
                  </label>
                  <button
                    className={tool === "pen" ? "on" : ""}
                    title="Pen (D) · 크기 [ ] · 실행취소 Ctrl+Z"
                    onClick={() => setTool("pen")}
                  >
                    🖌 Pen
                  </button>
                  <button
                    className={tool === "erase" ? "on" : ""}
                    title="Eraser (E)"
                    onClick={() => setTool("erase")}
                  >
                    ⌫ Eraser
                  </button>
                  <button
                    className={tool === "shape" ? "on" : ""}
                    title="Shapes (R)"
                    onClick={() => setTool("shape")}
                  >
                    ▱ Shapes
                  </button>
                </div>
                {/* 알약형 프롬프트 바 — 웹 편집기와 같은 한 줄 입력 + 우측 크레딧·라임 실행 버튼.
                    autoFocus 없음: 기본은 그리기 모드(단축키 유지), 입력은 클릭해야 시작 */}
                <div className="partial-edit-pill">
                  <textarea
                    rows={1}
                    placeholder="이미지를 어떻게 수정할까요? — 클릭해서 입력"
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
                  <span className="partial-edit-cost">
                    {cost != null ? `${cost} cr` : "…"}
                  </span>
                  <button
                    className="partial-edit-gen"
                    disabled={!canSubmit}
                    onClick={submit}
                    title={cost != null ? `Seedream 으로 생성 — 예상 ${cost} 크레딧` : "Seedream 으로 생성"}
                  >
                    {submitting ? "…" : "✦"}
                  </button>
                </div>
                {!workspaceReady && (
                  <div className="partial-edit-hint">워크스페이스 확인 후 생성할 수 있습니다.</div>
                )}
                {m.paramsModel === m.model && !m.paramsLoading && !aspect && (
                  <div className="partial-edit-hint">
                    모델 파라미터를 불러오지 못해 생성할 수 없습니다 — 다시 열어보세요.
                  </div>
                )}
              </>
            )}
          </>
        )}

        {stage === "result" && src && resultUrl && (
          <>
            <div className="partial-edit-stagebox" style={stageStyle}>
              {/* contain — 결과 비율이 enum 스냅으로 원본과 미세하게 다르면 늘어나 보이는 대신
                  얇은 레터박스로 흡수(무대 배경은 이미 어두움, 코덱스 WARN) */}
              <img
                src={showOriginal ? srcUrlRef.current : resultUrl}
                alt=""
                draggable={false}
                style={{ objectFit: "contain" }}
              />
            </div>
            <div className="partial-edit-tools">
              <button
                className={showOriginal ? "on" : ""}
                onPointerDown={() => setShowOriginal(true)}
                onPointerUp={() => setShowOriginal(false)}
                onPointerLeave={() => setShowOriginal(false)}
                title="누르고 있는 동안 원본 표시"
              >
                원본 비교(꾹)
              </button>
              <span className="partial-edit-toolspacer" />
              <button
                className="settings-action ghost"
                onClick={() => {
                  setResultUrl(null);
                  setStage("draw");
                }}
              >
                같은 주석으로 다시 수정
              </button>
            </div>
            <div className="partial-edit-hint">
              결과는 라이브러리 카드로 저장되어 있습니다 — 다운로드·태그도 카드에서.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
