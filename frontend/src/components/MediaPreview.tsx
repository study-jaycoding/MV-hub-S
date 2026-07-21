// 미디어 미리보기 — 이미지/동영상 클릭 시 떠오르는 플로팅 창(정보 팝업과 같은 구성).
// 새 브라우저 탭을 열지 않고 이 창에서 보여주고, 영상은 재생한다.
// 헤더를 잡고 드래그해 옮긴다. Esc/바깥 클릭으로 닫음.
import { useEffect, useRef, useState } from "react";
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
function previewDownloadName(url: string, name: string, type: string): string {
  const base = (name || "download").replace(/[\\/:*?"<>|]+/g, "_").trim() || "download";
  if (/\.[a-z0-9]{2,4}$/i.test(base)) return base; // 에셋 파일명 — 확장자 있음
  const m = url.split("?")[0].match(/\.([a-z0-9]{2,4})$/i);
  const ext = m ? m[1] : type === "video" ? "mp4" : type === "audio" ? "mp3" : "png";
  return `${base}.${ext}`;
}

export function MediaPreview({ target, onClose, onOpenInBoard }: Props) {
  const [pos, setPos] = useState({ x: 0, y: 0 }); // 화면 중앙 기준 오프셋
  const drag = useRef<{ ox: number; oy: number; sx: number; sy: number } | null>(null);
  // 같은 목록(items)이 넘어오면 ←/→ 로 그 안에서 이전·다음 미디어로 이동(생성·에셋 공통).
  const items = target.items;
  const [idx, setIdx] = useState(target.index ?? 0);
  // 다른 카드/에셋을 새로 열면(=target 교체) 인덱스를 그 시작 위치로 리셋.
  useEffect(() => {
    setIdx(target.index ?? 0);
  }, [target]);
  const cur = items && items[idx] ? items[idx] : target;

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
            <button
              className="lin-board-btn preview-dl-btn"
              title="원본 다운로드"
              onClick={() => downloadOne(cur.url, previewDownloadName(cur.url, cur.name, cur.type))}
            >
              ⤓ 다운로드
            </button>
            {onOpenInBoard && cur.genId && (
              <button
                className="lin-board-btn preview-board-btn"
                title="구성탭에서 원본 → 파생 트리로 한눈에 보기"
                onClick={() => onOpenInBoard(cur.genId!)}
              >
                ⧉ 히스토리 보기
              </button>
            )}
          </div>
          <button className="assets-x" onClick={onClose} title="닫기">
            ✕
          </button>
        </header>
        <div className="media-preview-body">
          {cur.type === "video" ? (
            <video src={cur.url} controls autoPlay loop />
          ) : cur.type === "audio" ? (
            <audio src={cur.url} controls autoPlay />
          ) : (
            <img src={cur.url} alt={cur.name} draggable={false} />
          )}
        </div>
      </div>
    </div>
  );
}
