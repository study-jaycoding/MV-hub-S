// 부분 수정 모달 — 힉스필드 웹 편집기의 브러시 수정과 같은 원리(실측으로 확정):
// 마스크는 서버로 가지 않는다. 원본을 참조로 넣어 전체를 재생성한 뒤, 브러시로 칠한
// 영역만 브라우저에서 원본 위에 합성한다(경계 페더). 중간 생성물은 평소처럼 라이브러리
// 카드로 남아 출처·프롬프트가 보존된다. 프로토타입 저장 = PNG 다운로드.
//
// 코덱스 설계 합의 반영:
//  · 원본/결과 모두 fetchBlob→ImageBitmap (CDN 원본의 캔버스 오염 차단, /api/download 폴백)
//  · 좌표계 = 이미지 비율 그대로의 wrapper(aspect-ratio) 위 오버레이 — 레터박스 어긋남 없음
//  · 마스크는 벡터 스트로크 목록(undo=pop+재렌더), 작업 해상도 상한 12MP(메모리 폭주 방지)
//  · 합성 순서: rawMask →(blur)→ featherMask → resultLayer(destination-in) → 원본 위 source-over
//  · 결과는 원본 비율로 중앙 cover 합성(비균일 stretch 왜곡 방지)
//  · 제출은 prepareCreate 클로저(재시도에도 idempotency key 유지), 빈 마스크/빈 프롬프트 가드
//  · 폴링 2초 재귀 setTimeout + runToken, 180초 후에도 실패 처리하지 않고 '오래 걸림' 안내만
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type GenerationCreateBody } from "../../api";
import { fetchBlob, downloadName } from "../../lib/download";
import { saveToDownloadDir } from "../../lib/downloadDir";
import { flashMsg } from "../../lib/flash";
import { isGenerationWorkspaceReady } from "../../lib/workspaceContext";
import { useModels } from "../../lib/useModels";
import type { Generation, WorkspaceContext } from "../../types";

const MAX_WORK_PIXELS = 12_000_000; // 12MP — rawMask/feather/layer/final 4장 동시 보유 상한
const POLL_MS = 2_000;
const SLOW_AFTER_MS = 180_000; // 이후에도 계속 감시 — 실패 처리 아님(이중 과금 방지)

interface Stroke {
  erase: boolean;
  size: number; // 작업 해상도 px
  points: { x: number; y: number }[];
}

type Stage = "load" | "draw" | "wait" | "compose";

function pathStroke(ctx: CanvasRenderingContext2D, stroke: Stroke) {
  ctx.globalCompositeOperation = stroke.erase ? "destination-out" : "source-over";
  ctx.strokeStyle = "#ffffff";
  ctx.fillStyle = "#ffffff";
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
  const [note, setNote] = useState(""); // 축소 작업·크롭 예정 등 비차단 안내

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

  // ── 마스크(벡터 스트로크 → rawMask 캔버스) ──
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [tool, setTool] = useState<"brush" | "erase">("brush");
  const [brushSize, setBrushSize] = useState(60); // 작업 해상도 px
  const rawMaskRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const liveStrokeRef = useRef<Stroke | null>(null);

  const renderMask = (list: Stroke[], live?: Stroke | null) => {
    const raw = rawMaskRef.current;
    if (!raw) return;
    const ctx = raw.getContext("2d");
    if (!ctx) return;
    ctx.save();
    ctx.clearRect(0, 0, raw.width, raw.height);
    for (const s of list) pathStroke(ctx, s);
    if (live) pathStroke(ctx, live);
    ctx.restore();
    // 화면 표시: rawMask 를 라임 반투명으로 틴트
    const overlay = overlayRef.current;
    const octx = overlay?.getContext("2d");
    if (!overlay || !octx) return;
    octx.save();
    octx.clearRect(0, 0, overlay.width, overlay.height);
    octx.globalAlpha = 0.45;
    octx.drawImage(raw, 0, 0);
    octx.globalCompositeOperation = "source-in";
    octx.globalAlpha = 1;
    octx.fillStyle = "#bef264";
    octx.fillRect(0, 0, overlay.width, overlay.height);
    octx.restore();
  };
  useEffect(() => {
    if (stage === "draw") renderMask(strokes);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, strokes, src]);

  const activePointerRef = useRef<number | null>(null); // 멀티 포인터 혼선 방지 — 첫 포인터만
  const toWork = (e: React.PointerEvent) => {
    const overlay = overlayRef.current;
    if (!overlay || !src) return null;
    const rect = overlay.getBoundingClientRect();
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
    activePointerRef.current = e.pointerId;
    (e.target as Element).setPointerCapture(e.pointerId);
    liveStrokeRef.current = { erase: tool === "erase", size: brushSize, points: [p] };
    renderMask(strokes, liveStrokeRef.current);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const live = liveStrokeRef.current;
    if (!live || e.pointerId !== activePointerRef.current) return;
    const p = toWork(e);
    if (!p) return;
    live.points.push(p);
    renderMask(strokes, live);
  };
  const endStroke = (e: React.PointerEvent) => {
    if (e.pointerId !== activePointerRef.current) return;
    activePointerRef.current = null;
    const live = liveStrokeRef.current;
    if (!live) return;
    liveStrokeRef.current = null;
    setStrokes((prev) => [...prev, live]);
  };
  const hasBrush = strokes.some((s) => !s.erase);
  // 진짜 잉크가 남았는지 — 지우개로 전부 지운 마스크로 유료 생성을 막는다(코덱스 WARN).
  // 축소 미러는 가는 선을 평균화로 놓친다(false negative) → 원본 해상도를 세로 조각
  // 단위로 정확 검사, 첫 잉크에서 조기 종료. 제출 클릭 1회에만 실행되므로 비용 수용.
  const maskHasInk = (): boolean => {
    const raw = rawMaskRef.current;
    if (!raw) return false;
    const ctx = raw.getContext("2d", { willReadFrequently: true });
    if (!ctx) return hasBrush; // 검사 불가 — 기록 기준으로 폴백
    const stripe = 256;
    for (let y = 0; y < raw.height; y += stripe) {
      const rows = Math.min(stripe, raw.height - y);
      const data = ctx.getImageData(0, y, raw.width, rows).data;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 0) return true;
    }
    return false;
  };

  // ── 모델·비율·견적 (useModels 독립 인스턴스 — SceneModelModal 선례) ──
  const m = useModels(() => {});
  useEffect(() => {
    m.setType("image");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
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
  const [result, setResult] = useState<{ bmp: ImageBitmap; w: number; h: number } | null>(null);

  const workspaceReady = isGenerationWorkspaceReady(workspace);
  // aspect 필수 — 파라미터 로드 실패로 빈 스키마가 되면 기본 1:1 로 심하게 크롭된
  // 유료 결과가 나온다(코덱스 WARN). 지원 이미지 모델은 전부 aspect enum 을 가진다.
  const canSubmit =
    stage === "draw" &&
    !submitting &&
    !!src &&
    hasBrush &&
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
              const bmp = await createImageBitmap(blob);
              if (token !== runTokenRef.current) {
                bmp.close();
                return;
              }
              setResult({ bmp, w: bmp.width, h: bmp.height });
              setStage("compose");
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

  const submit = async () => {
    if (!canSubmit || !src) return;
    if (!maskHasInk()) {
      setError("마스크가 비어 있습니다 — 지운 곳 말고 남길 곳을 칠하세요.");
      return;
    }
    setError("");
    setSubmitting(true);
    const body: GenerationCreateBody = {
      prompt: prompt.trim(),
      model: m.model,
      params: aspect ? { aspect_ratio: aspect } : {},
      references: [
        {
          file_path: asset!.file_path,
          type: "image",
          role: "@Image1",
          source_gen_id: gen.id,
          thumbnail: asset!.thumbnail_path || undefined,
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
    // 계보는 references 의 source_gen_id 가 이미 만든다(서버가 reference 엣지 기록,
    // deriveFrom 은 전이 축소로 무효 — 코덱스 확인). 별도 호출 없음.
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

  // ── 합성 ──
  const [feather, setFeather] = useState(8);
  const [showOriginal, setShowOriginal] = useState(false);
  const previewRef = useRef<HTMLCanvasElement | null>(null);
  const scratchRef = useRef<{ feathered: HTMLCanvasElement; layer: HTMLCanvasElement } | null>(
    null,
  );
  useEffect(() => {
    if (stage !== "compose" || !src || !result) return;
    const canvas = previewRef.current;
    const raw = rawMaskRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !raw || !ctx) return;
    renderMask(strokes); // rawMask 를 최신 스트로크로 보장(스테이지 전환 직후 대비)
    ctx.save();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(src.bmp, 0, 0, src.w, src.h);
    if (!showOriginal) {
      // scratch 캔버스 2장은 재사용 — 페더 슬라이더 드래그마다 12MP 백킹 스토어를
      // 새로 할당하면 메모리가 급증한다(코덱스 WARN).
      if (!scratchRef.current) {
        scratchRef.current = {
          feathered: document.createElement("canvas"),
          layer: document.createElement("canvas"),
        };
      }
      const { feathered, layer } = scratchRef.current;
      // featherMask: rawMask 사본에만 blur — 원본·결과에는 filter 미적용
      if (feathered.width !== src.w || feathered.height !== src.h) {
        feathered.width = src.w;
        feathered.height = src.h;
      }
      const fctx = feathered.getContext("2d")!;
      fctx.save();
      fctx.clearRect(0, 0, src.w, src.h);
      if (feather > 0) fctx.filter = `blur(${feather}px)`;
      fctx.drawImage(raw, 0, 0);
      fctx.restore();
      // resultLayer: 결과를 중앙 cover 로 그린 뒤 마스크로 잘라낸다(비균일 stretch 금지)
      if (layer.width !== src.w || layer.height !== src.h) {
        layer.width = src.w;
        layer.height = src.h;
      }
      const lctx = layer.getContext("2d")!;
      lctx.save();
      lctx.clearRect(0, 0, src.w, src.h);
      const scale = Math.max(src.w / result.w, src.h / result.h);
      const dw = result.w * scale;
      const dh = result.h * scale;
      lctx.drawImage(result.bmp, (src.w - dw) / 2, (src.h - dh) / 2, dw, dh);
      lctx.globalCompositeOperation = "destination-in";
      lctx.drawImage(feathered, 0, 0);
      lctx.restore();
      ctx.drawImage(layer, 0, 0);
    }
    ctx.restore();
  }, [stage, src, result, feather, showOriginal]);
  useEffect(() => () => result?.bmp.close(), [result]);

  const savePng = () => {
    const canvas = previewRef.current;
    if (!canvas) return;
    canvas.toBlob(async (blob) => {
      if (!blob) {
        flashMsg("PNG 인코딩에 실패했습니다.");
        return;
      }
      const name = `${downloadName(gen, "image").replace(/\.png$/i, "")}_partial.png`;
      if (await saveToDownloadDir(name, blob)) {
        flashMsg(`저장됨: ${name}`);
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, "image/png");
  };

  // Esc 닫기 — 제출 요청 중·감시 중엔 금지: 제출 중 닫고 다시 열면 새 idempotency key 로
  // 유료 요청이 이중 생성된다(코덱스 BLOCK). 감시 중 종료는 '감시 중단' 버튼으로만.
  const closable = stage !== "wait" && !submitting;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && closable) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closable, onClose]);

  const slow = elapsed > SLOW_AFTER_MS;
  // 비율 보존 무대 크기 — 높이 상한(62vh)을 비율로 폭 상한에 옮겨, 어느 축이 클램프돼도
  // 상자 비율 = 이미지 비율(오버레이 좌표 매핑의 전제)이 유지된다.
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
            칠한 부분만 다시 생성해 원본에 합성 — 나머지는 그대로
          </span>
          {closable && (
            <button className="assets-x" onClick={onClose} title="닫기">
              ✕
            </button>
          )}
        </header>

        {error && <div className="partial-edit-error">{error}</div>}
        {note && <div className="partial-edit-note">{note}</div>}

        {/* rawMask — 벡터 스트로크의 실체 캔버스(작업 해상도). 그리기·합성 양 단계가 쓰므로
            스테이지 조건 밖에 상시 mount(그리기 블록 안에 두면 합성 단계에서 사라진다). */}
        {src && (
          <canvas ref={rawMaskRef} width={src.w} height={src.h} style={{ display: "none" }} />
        )}

        {stage === "load" && <div className="partial-edit-loading">원본 불러오는 중…</div>}

        {(stage === "draw" || stage === "wait") && src && (
          <>
            <div className="partial-edit-stagebox" style={stageStyle}>
              <img src={srcUrlRef.current} alt="" draggable={false} />
              <canvas
                ref={(el) => {
                  overlayRef.current = el;
                  if (el && (el.width !== src.w || el.height !== src.h)) {
                    el.width = src.w;
                    el.height = src.h;
                    renderMask(strokes);
                  }
                }}
                className={stage === "draw" ? "is-drawing" : ""}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={endStroke}
                onPointerCancel={endStroke}
                onLostPointerCapture={endStroke}
              />
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
                <div className="partial-edit-tools">
                  <button
                    className={tool === "brush" ? "on" : ""}
                    onClick={() => setTool("brush")}
                  >
                    🖌 브러시
                  </button>
                  <button
                    className={tool === "erase" ? "on" : ""}
                    onClick={() => setTool("erase")}
                  >
                    ⌫ 지우개
                  </button>
                  <label>
                    크기
                    <input
                      type="range"
                      min={10}
                      max={200}
                      value={brushSize}
                      onChange={(e) => setBrushSize(Number(e.target.value))}
                    />
                  </label>
                  <button disabled={!strokes.length} onClick={() => setStrokes((p) => p.slice(0, -1))}>
                    ↩ 실행취소
                  </button>
                  <button disabled={!strokes.length} onClick={() => setStrokes([])}>
                    전체 지우기
                  </button>
                </div>
                {/* 하단 프롬프트 독과 같은 모양 — 한 상자에 입력창 + 알약 컨트롤 + 라임 Generate */}
                <div className="partial-edit-dock">
                  <textarea
                    autoFocus
                    placeholder="칠한 부분을 무엇으로 바꿀까요? (예: 보름달을 초승달로)"
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                  />
                  <div className="partial-edit-dockrow">
                    <select
                      className="partial-edit-modelselect"
                      title="수정에 쓸 이미지 모델"
                      value={m.model}
                      onChange={(e) => m.setModel(e.target.value)}
                    >
                      {m.typeModels.map((tm) => (
                        <option key={tm.job_set_type} value={tm.job_set_type}>
                          {tm.display_name}
                        </option>
                      ))}
                    </select>
                    <span className="sl-chip" title="원본과 같은 비율로 생성됩니다">
                      □ {aspect ?? "—"}
                    </span>
                    <span className="partial-edit-dockspacer" />
                    <button
                      className="sl-gen"
                      disabled={!canSubmit}
                      onClick={submit}
                      title={cost != null ? `예상 ${cost} 크레딧` : undefined}
                    >
                      {submitting ? "요청 중…" : "생성 ✦"}
                      <span className={"sl-cost" + (cost == null ? " loading" : "")}>
                        {cost != null ? cost : "…"}
                      </span>
                    </button>
                  </div>
                  {!hasBrush && <div className="partial-edit-hint">브러시로 수정할 부분을 칠하세요.</div>}
                  {!workspaceReady && (
                    <div className="partial-edit-hint">워크스페이스 확인 후 생성할 수 있습니다.</div>
                  )}
                  {m.paramsModel === m.model && !m.paramsLoading && !aspect && (
                    <div className="partial-edit-hint">
                      모델 파라미터를 불러오지 못해 생성할 수 없습니다 — 모델을 바꾸거나 다시 열어보세요.
                    </div>
                  )}
                </div>
              </>
            )}
          </>
        )}

        {stage === "compose" && src && (
          <>
            <div className="partial-edit-stagebox" style={stageStyle}>
              <canvas ref={previewRef} width={src.w} height={src.h} />
            </div>
            <div className="partial-edit-tools">
              <button
                className={showOriginal ? "" : "on"}
                onPointerDown={() => setShowOriginal(true)}
                onPointerUp={() => setShowOriginal(false)}
                onPointerLeave={() => setShowOriginal(false)}
                title="누르고 있는 동안 원본 표시"
              >
                원본 비교(꾹)
              </button>
              <label>
                경계 부드럽게
                <input
                  type="range"
                  min={0}
                  max={30}
                  value={feather}
                  onChange={(e) => setFeather(Number(e.target.value))}
                />
              </label>
              <button className="settings-action" onClick={savePng}>
                PNG 저장
              </button>
              <button
                className="settings-action ghost"
                onClick={() => {
                  result?.bmp.close();
                  setResult(null);
                  setStage("draw");
                }}
              >
                같은 마스크로 다시 생성
              </button>
            </div>
            <div className="partial-edit-hint">
              중간 생성물은 라이브러리 카드로 남습니다(출처·프롬프트 보존). 저장은 합성된 PNG 입니다.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
