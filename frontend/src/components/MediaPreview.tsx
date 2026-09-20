// 미디어 미리보기 — 이미지/동영상 클릭 시 떠오르는 플로팅 창(정보 팝업과 같은 구성).
// 새 브라우저 탭을 열지 않고 이 창에서 보여주고, 영상은 재생한다.
// 헤더를 잡고 드래그해 옮긴다. Esc/바깥 클릭으로 닫음.
import { useEffect, useRef, useState } from "react";
import { recordGenerationView } from "../lib/generationViews";
import { APP_EVENTS } from "../lib/appEvents";
import { downloadOne } from "../lib/download";
import { addWindowPointerDrag, removeWindowPointerDrag } from "../lib/windowDrag";
import type { PreviewTarget } from "../types";

interface Props {
  target: PreviewTarget;
  onClose: () => void;
  onOpenInBoard?: (genId: string) => void; // 결과물이면 '구성에서 보기'(구성탭 히스토리 트리)
}

// 크게 보기에서 받는 파일명 — 에셋은 이름에 이미 확장자가 있으니 그대로 쓰고, 생성물은 프롬프트
// 조각(확장자 없음)이라 URL 경로(쿼리 제거) 또는 타입 기본값으로 확장자를 붙인다. 경로 금지문자는 _.
// uniq: 같은 배치의 변형들은 프롬프트(name)가 전부 같아 파일명이 겹친다 → 지정 폴더 저장 시 서로
// 덮어씀. 생성물엔 고유 id(genId 앞 8자)를 접미사로 붙여 변형마다 다른 파일로 저장한다.
function previewDownloadName(url: string, name: string, type: string, uniq?: string): string {
  const base = (name || "download").replace(/[\\/:*?"<>|]+/g, "_").trim() || "download";
  if (/\.[a-z0-9]{2,4}$/i.test(base)) return base; // 에셋 파일명 — 확장자 있음(이미 고유)
  const m = url.split("?")[0].match(/\.([a-z0-9]{2,4})$/i);
  const ext = m ? m[1] : type === "video" ? "mp4" : type === "audio" ? "mp3" : "png";
  const suffix = uniq ? `-${uniq.slice(0, 8)}` : "";
  return `${base}${suffix}.${ext}`;
}

// 자리 표시 크기 = 원본이 놓일 크기. assets.css 의 `.media-preview-body img, video`(max 78vw × 74vh, contain)와 같은 상자에
// 썸네일 비율로 맞춘다 — 원본이 그 상자보다 크면(생성물 대부분) 원본이 와도 크기가 안 바뀐다.
// ponytail: 원본 치수를 모른다. 원본이 상자보다 작으면(옛 512px 생성물 등) 원본이 올 때 한 번 줄어든다. 썸네일 제 크기로
// 두면 반대로 흔한 경우(큰 원본)마다 커지며 튄다 — 목록 응답에 원본 치수가 실리면 그것으로 바꾼다.
export function fitPreviewBox(nw: number, nh: number, vw: number, vh: number, upscale = true): { w: number; h: number } {
  const k = Math.min((vw * 0.78) / nw, (vh * 0.74) / nh, upscale ? Infinity : 1);
  return { w: Math.round(nw * k), h: Math.round(nh * k) };
}

export function MediaPreview({ target, onClose, onOpenInBoard }: Props) {
  const [pos, setPos] = useState({ x: 0, y: 0 }); // 화면 중앙 기준 오프셋
  const drag = useRef<{ ox: number; oy: number; sx: number; sy: number } | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null); // 스페이스바 재생/일시정지용
  // 같은 목록(items)이 넘어오면 ←/→ 로 그 안에서 이전·다음 미디어로 이동(생성·에셋 공통).
  const items = target.items;
  const [idx, setIdx] = useState(target.index ?? 0);
  // 다른 카드/에셋을 새로 열면(=target 교체) 인덱스를 그 시작 위치로 리셋.
  useEffect(() => {
    setIdx(target.index ?? 0);
  }, [target]);
  const cur = items && items[idx] ? items[idx] : target;

  // '마지막으로 본' 표시 기록 — 미리보기에 그 항목이 실제로 표시된 순간에만.
  // ★target 이 막 바뀐 첫 패스에서는 위의 리셋 effect 가 아직 안 돌아 idx 가 옛 값이다.
  //   그때 기록하면 새 목록 + 옛 인덱스 = 엉뚱한 항목이 찍히므로 target.index 를 쓴다.
  const lastTargetRef = useRef<PreviewTarget | null>(null);
  const lastRecordedRef = useRef("");
  useEffect(() => {
    const fresh = lastTargetRef.current !== target;
    lastTargetRef.current = target;
    const effIdx = fresh ? target.index ?? 0 : idx;
    const item = items && items[effIdx] ? items[effIdx] : target;
    if (!item.genId) return; // 에셋(파일) 미리보기 — 생성물이 아니라 기록 대상이 아니다
    const sceneId = item.sceneId || target.sceneId || "";
    const cardId = item.cardId || target.cardId || "";
    // 캔버스 씬은 카드까지, 캔버스 밖 칸(''·@team)은 씬 이름만 — 규칙 검증은 recordGenerationView 가 한다.
    const ctx = sceneId ? { sceneId, cardId } : null;
    const key = [sceneId, cardId, item.genId].join("|");
    if (lastRecordedRef.current === key) return; // 재렌더·프리페치로 다시 찍지 않는다
    lastRecordedRef.current = key;
    void recordGenerationView(item.genId, ctx);
  }, [target, idx, items]);

  // 이웃(앞뒤) 이미지를 미리 브라우저 캐시에 받아둔다 → ←/→ 로 넘길 때 이미 받아둬서 즉시 표시(딜레이
  // 제거). 원본 화질 그대로 보여주되(다운로드는 필요할 때만), 디스크엔 안 쌓이고 브라우저 임시 캐시만 쓴다.
  useEffect(() => {
    if (!items || items.length < 2) return;
    for (const j of [idx + 1, idx - 1, idx + 2, idx - 2]) {
      const it = items[j];
      if (it && it.type === "image" && it.url) {
        const im = new Image();
        im.fetchPriority = "low"; // 지금 보는 이미지보다 낮은 우선순위 — 현재 표시와 대역폭 경쟁 방지
        im.src = it.url; // 원본 URL — 실제 표시와 같은 것이라 그때 캐시 히트로 즉시 뜬다
      }
    }
    // cleanup 없음 — img.src="" 는 진행 중 요청을 못 멈추고 오히려 문서 URL 재요청을 유발할 수 있어 뺀다.
    // 프리페치는 곧 볼 이미지라 완료돼도 낭비가 아니다(브라우저 캐시로 재사용). Image 객체는 곧 GC 된다.
  }, [items, idx]);

  // 원본이 오는 동안의 자리 표시 — 연 곳이 이미 띄운 썸네일(브라우저 캐시)을 원본이 놓일 크기로 먼저 깐다.
  // 원본은 Higgsfield CDN 에서 오고 첫 바이트까지 ~0.9초·영상은 2~3초(2026-09-20 실측)라 그동안 창이 비어 있었다.
  // 받는 시간은 그대로고 빈 화면만 없앤다. 썸네일이 없거나 못 읽으면 ph=null → 종전과 같은 화면.
  const [ph, setPh] = useState<{ url: string; w: number; h: number } | null>(null);
  const [readyUrl, setReadyUrl] = useState<string | null>(null); // 원본이 제 크기로 그려질 수 있게 된 url
  // 항목이 바뀌면 준비 표시를 바로 지운다 — A→B→A 로 돌아오면 A 의 img·video 는 새로 마운트되는데 옛 표시가
  // 남아 있으면 자리 표시가 곧장 걷힌다(Codex 리뷰). effect 가 아니라 렌더 중에 고쳐 한 프레임도 새지 않게.
  const [seenUrl, setSeenUrl] = useState(cur.url);
  if (seenUrl !== cur.url) {
    setSeenUrl(cur.url);
    setReadyUrl(null);
  }
  const thumb = cur.type === "audio" ? null : cur.thumb || null;
  useEffect(() => {
    setPh(null);
    if (!thumb) return;
    let alive = true;
    const im = new Image();
    im.onload = () => {
      if (alive && im.naturalWidth && im.naturalHeight)
        setPh({ url: thumb, ...fitPreviewBox(im.naturalWidth, im.naturalHeight, window.innerWidth, window.innerHeight) });
    };
    im.src = thumb;
    return () => {
      alive = false;
    };
  }, [thumb]);
  const waiting = ph && ph.url === thumb && readyUrl !== cur.url ? ph : null;
  // 영상은 표지를 보여 주는 동안 **표지 크기**가 제 크기다(HTML 규격) — 재생 정보가 왔다고 고정 크기를 풀면 재생이 시작될
  // 때까지(자동 재생이 막히면 계속) 창이 썸네일 크기(256px)로 줄어든다(2026-09-20 브라우저 실측). 재생 정보가 오면 영상의
  // 실제 크기로 바꿔 잡고(CSS 가 냈을 크기 = 상자보다 크면 맞추고 작으면 그대로), 실제로 재생이 시작되면 CSS 에 돌려준다.
  const [videoBox, setVideoBox] = useState<{ url: string; w: number; h: number } | null>(null);
  const videoSize =
    !thumb || readyUrl === cur.url ? undefined : videoBox && videoBox.url === cur.url ? videoBox : waiting;

  useEffect(() => {
    // 크게 보기는 정보팝업/그리드 위에 떠 있으므로 키를 캡처 단계에서 먼저 가로챈다.
    // Esc → 자기만 닫기(stopPropagation). ←/→ → 목록 내 이동(뒤 그리드 포커스 이동과 충돌 방지).
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      } else if (items && items.length > 1 && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        e.stopPropagation();
        setIdx((i) => {
          const n = e.key === "ArrowLeft" ? i - 1 : i + 1;
          return Math.max(0, Math.min(items.length - 1, n));
        });
      } else if (e.code === "Space" || e.key === " ") {
        // 스페이스바 → 재생/일시정지(네이티브 controls 는 포커스가 있어야만 먹으므로 직접 처리).
        // 단 버튼·입력 등에 포커스가 있으면 그 요소의 기본 동작(클릭/입력)을 살린다(capture 로 가로채지 않음).
        const t = e.target instanceof Element ? e.target : null;
        if (t?.closest("button, a, input, textarea, select, [role=button], [contenteditable]")) return;
        const v = videoRef.current;
        if (!v) return;
        e.preventDefault();
        e.stopPropagation();
        if (v.paused) void v.play().catch(() => {});
        else v.pause();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, items]);

  const onDragStart = (e: React.PointerEvent) => {
    drag.current = { ox: pos.x, oy: pos.y, sx: e.clientX, sy: e.clientY };
    addWindowPointerDrag(onDragMove, onDragEnd);
  };
  const onDragMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    setPos({ x: d.ox + (e.clientX - d.sx), y: d.oy + (e.clientY - d.sy) });
  };
  const onDragEnd = () => {
    drag.current = null;
    removeWindowPointerDrag(onDragMove, onDragEnd);
  };

  return (
    <div className="preview-backdrop" onMouseDown={onClose}>
      <div
        className="media-preview"
        style={{ transform: `translate(calc(-50% + ${pos.x}px), calc(-50% + ${pos.y}px))` }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="info-head" onPointerDown={onDragStart}>
          <span className="info-title" title={cur.name}>
            {cur.type === "video" ? "▶ " : cur.type === "audio" ? "🎵 " : "🖼 "}
            {cur.name}
            {items && items.length > 1 && (
              <span className="preview-count">
                {" "}
                {idx + 1}/{items.length}
              </span>
            )}
          </span>
          <div className="preview-head-actions">
            {cur.type === "image" && cur.genId && (
              <button
                className="lin-board-btn preview-edit-btn"
                title="이미지 위에 펜·도형으로 표시해 수정 지시 (Seedream)"
                onClick={() => {
                  window.dispatchEvent(
                    new CustomEvent(APP_EVENTS.partialEdit, {
                      detail: { genId: cur.genId },
                    }),
                  );
                  onClose();
                }}
              >
                🖌 부분 수정
              </button>
            )}
            {onOpenInBoard && cur.genId && (
              <button
                className="lin-board-btn preview-board-btn"
                title="구성탭에서 원본 → 파생 트리로 한눈에 보기"
                onClick={() => onOpenInBoard(cur.genId!)}
              >
                ⧉ 히스토리 보기
              </button>
            )}
            <button
              className="lin-board-btn preview-dl-btn"
              title="원본 다운로드"
              onClick={() =>
                downloadOne(
                  cur.url,
                  previewDownloadName(cur.url, cur.name, cur.type, cur.genId),
                  cur.genId,
                )
              }
            >
              ⤓ 다운로드
            </button>
          </div>
          <button className="assets-x" onClick={onClose} title="닫기">
            ✕
          </button>
        </header>
        <div className="media-preview-body">
          {cur.type === "video" ? (
            <video
              ref={videoRef}
              key={cur.url}
              src={cur.url}
              poster={thumb ?? undefined}
              style={videoSize ? { width: videoSize.w, height: videoSize.h } : undefined}
              onLoadedMetadata={(e) => {
                const v = e.currentTarget;
                if (thumb && v.videoWidth && v.videoHeight)
                  setVideoBox({ url: cur.url, ...fitPreviewBox(v.videoWidth, v.videoHeight, window.innerWidth, window.innerHeight, false) });
              }}
              onPlaying={() => setReadyUrl(cur.url)}
              controls
              autoPlay
              loop
            />
          ) : cur.type === "audio" ? (
            <audio src={cur.url} controls autoPlay />
          ) : thumb ? (
            <div className="media-preview-stack">
              {waiting && (
                <img
                  className="media-preview-ph"
                  src={waiting.url}
                  alt=""
                  aria-hidden="true"
                  draggable={false}
                  style={{ width: waiting.w, height: waiting.h }}
                />
              )}
              {/* 항목마다 새 img — 앞 장이 남아 새 자리 표시를 가리지 않게 */}
              <img
                key={cur.url}
                src={cur.url}
                alt={cur.name}
                draggable={false}
                onLoad={() => setReadyUrl(cur.url)}
              />
            </div>
          ) : (
            // 썸네일을 안 넘기는 곳(Assets·레퍼런스·정보 팝업)은 종전 마크업 그대로
            <img src={cur.url} alt={cur.name} draggable={false} />
          )}
        </div>
      </div>
    </div>
  );
}
