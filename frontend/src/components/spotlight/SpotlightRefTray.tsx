import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from "react";
import { displayRefThumb, hideBrokenImg, showLoadedImg } from "../../lib/media";
import { refSrc } from "../../lib/promptParts";
import type { ChipRef } from "../../lib/promptEditor";
import type { PreviewTarget } from "../../types";
import {
  seedanceHasTokenRoles,
  seedanceTrayBadge,
  seedanceTrayBadgeTitle,
  seedanceTrayRole,
  seedanceTrayTypeIndex,
  usesMediaRefTokens,
  usesSeedanceMediaRefs,
  type SeedanceTokenRoles,
} from "../../lib/seedancePrompt";
import { MediaThumbnail } from "../MediaThumbnail";

// from_card: 이 참조가 씬의 연결된 레퍼런스 카드/리스트에서 온 것인지(SceneRef 와 왕복 시 보존해야
//   disconnect 후에도 유령 참조로 남지 않는다). 일반 트레이 항목엔 없음.
export type SpotlightTrayRef = ChipRef & { uid: string; from_card?: boolean };

interface Props {
  trayRefs: SpotlightTrayRef[];
  model: string;
  liveSeedanceRoles: SeedanceTokenRoles;
  onDragOver: (event: DragEvent<HTMLElement>) => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  onReorder: (from: number, insertIndex: number) => void; // 마우스 드래그로 확정된 순서변경(from → insertIndex)
  onRemove: (index: number) => void;
  onClearAll: () => void;
  onPreview?: (target: PreviewTarget) => void; // 항목 더블클릭 → 원본 크게 보기
}

export function SpotlightRefTray({
  trayRefs,
  model,
  liveSeedanceRoles,
  onDragOver,
  onDrop,
  onKeyDown,
  onReorder,
  onRemove,
  onClearAll,
  onPreview,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  // 순서변경 드래그 — 삽입 위치 세로 흰 선(화면좌표·fixed) + 잡고 있는 항목(흐리게)
  const [line, setLine] = useState<{ x: number; y: number; h: number } | null>(null);
  const [fromIdx, setFromIdx] = useState<number | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanupRef.current?.(), []); // 드래그 중 언마운트 시 리스너 정리

  // 항목을 마우스로 잡아 순서 변경 — HTML5 네이티브 드래그 대신(빠르게 움직여도 안정적).
  // 4px 이상 움직여야 시작(단일/더블 클릭은 그대로 미리보기·선택). 삽입 위치를 흰 세로선으로 표시.
  const startReorder = (e: MouseEvent<HTMLDivElement>, index: number) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button")) return; // × 등 버튼은 제외
    const container = containerRef.current;
    if (!container) return;
    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;
    let insertIndex = -1;
    const GAP = 4;
    const recompute = (cx: number, cy: number) => {
      const items = Array.from(container.querySelectorAll<HTMLElement>("[data-tidx]"));
      if (!items.length) return;
      // 가로 배치 — 중심이 포인터에 가장 가까운 항목 기준, 포인터가 그 중심보다 오른쪽이면 뒤에 삽입.
      let best = 0, bestD = Infinity, after = false;
      for (let i = 0; i < items.length; i++) {
        const r = items[i].getBoundingClientRect();
        const c = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        const d = Math.hypot(cx - c.x, cy - c.y);
        if (d < bestD) { bestD = d; best = i; after = cx > c.x; }
      }
      const idx = after ? best + 1 : best;
      // 선은 컨테이너 기준 로컬 좌표(absolute) — 독에 backdrop-filter 가 있어 position:fixed 는
      // 화면이 아니라 독 기준으로 잡혀 엉뚱한 곳에 놓인다. 가로 스크롤도 반영(scrollLeft/Top).
      const cr = container.getBoundingClientRect();
      const lx = (vx: number) => vx - cr.left + container.scrollLeft;
      const ly = (vy: number) => vy - cr.top + container.scrollTop;
      if (idx < items.length) {
        const r = items[idx].getBoundingClientRect();
        setLine({ x: lx(r.left) - GAP, y: ly(r.top), h: r.height });
      } else {
        const r = items[items.length - 1].getBoundingClientRect();
        setLine({ x: lx(r.right) + GAP - 3, y: ly(r.top), h: r.height });
      }
      insertIndex = idx;
    };
    const onMove = (ev: globalThis.MouseEvent) => {
      if (!dragging) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;
        dragging = true;
        setFromIdx(index);
      }
      recompute(ev.clientX, ev.clientY);
    };
    const finish = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      cleanupRef.current = null;
      setLine(null);
      setFromIdx(null);
    };
    const onUp = () => {
      const wasDragging = dragging;
      const ii = insertIndex;
      finish();
      if (wasDragging && ii >= 0) onReorder(index, ii);
    };
    cleanupRef.current = finish;
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <div
      ref={containerRef}
      className="sl-reftray"
      tabIndex={0}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onKeyDown={onKeyDown}
      onMouseDown={(e: MouseEvent<HTMLDivElement>) => {
        if (!(e.target as HTMLElement).closest("button")) e.currentTarget.focus();
      }}
    >
      {trayRefs.length === 0 ? (
        <div className="sl-reftray-empty">
          에셋 창 또는 탐색기에서 파일을 여기로 드래그하세요 - 번호 순서대로 레퍼런스가 됩니다
        </div>
      ) : (
        <>
        {trayRefs.map((ref, index) => {
          // 타입 순번(@image1, @video1 …)은 레퍼런스 토큰 쓰는 모든 모델에서 보인다(이미지 모델 포함).
          const tokenVisible = usesMediaRefTokens(model) || seedanceHasTokenRoles(liveSeedanceRoles);
          const badgeRole = seedanceTrayRole(trayRefs, index, liveSeedanceRoles);
          const badgeTitle = seedanceTrayBadgeTitle(badgeRole);
          // 역할 배지(시작/끝/옴니 = S/E/O)는 seedance 전용 개념 → seedance 모델에서만(이미지 모델엔 안 뜸).
          const showRoleBadge = usesSeedanceMediaRefs(model);
          // 보이는 번호 = 프롬프트에 쓰는 번호(@image2, @video1 …).
          const displayIndex = tokenVisible ? seedanceTrayTypeIndex(trayRefs, index) : index + 1;
          return (
            <div
              key={ref.uid}
              className={"sl-reftray-item" + (fromIdx === index ? " reordering" : "")}
              data-tidx={index}
              onMouseDown={(e) => startReorder(e, index)}
              onDoubleClick={() =>
                onPreview?.({
                  url: refSrc(ref.file_path) || ref.thumb,
                  type: ref.type,
                  name: ref.name,
                })
              }
              title={`${displayIndex}. ${ref.name} · ${badgeTitle} · 드래그=순서변경 · 더블클릭=크게 보기`}
            >
              <span className="sl-reftray-num">{displayIndex}</span>
              {ref.type === "video" ? (
                <MediaThumbnail
                  thumb={displayRefThumb(ref, 256)}
                  isVideo
                  src={refSrc(ref.file_path)}
                  fallback={<span className="sl-reftray-ph" />}
                />
              ) : (ref.type as string) === "audio" ? (
                <span className="sl-reftray-ph">A</span>
              ) : displayRefThumb(ref) ? (
                <img
                  src={displayRefThumb(ref)}
                  alt=""
                  draggable={false}
                  onError={hideBrokenImg}
                  onLoad={showLoadedImg}
                />
              ) : (
                <span className="sl-reftray-ph" />
              )}
              {showRoleBadge && (
                <span className={`sl-reftray-role ${badgeRole}`} title={badgeTitle}>
                  {seedanceTrayBadge(badgeRole)}
                </span>
              )}
              <span className="sl-reftray-name">{ref.name}</span>
              {/* 연결된(from_card) 레퍼런스는 여기서 못 뺀다 — 캔버스에서 엣지를 끊어야 함(연결=레퍼런스). */}
              {ref.from_card ? (
                <span className="sl-reftray-linked" title="캔버스에서 연결된 레퍼런스 — 빼려면 엣지를 끊으세요">
                  🔗
                </span>
              ) : (
                <button
                  className="sl-reftray-x"
                  title="제거"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onRemove(index)}
                >
                  ×
                </button>
              )}
            </div>
          );
        })}
        {/* 레퍼런스 전체 비우기 — 생성 후에도 트레이는 남으므로(연속 변형용) 한 번에 초기화 */}
        <button
          className="sl-reftray-clear"
          title="레퍼런스 전체 비우기"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onClearAll}
        >
          <span className="sl-reftray-clear-ic" aria-hidden>⌫</span>
        </button>
        </>
      )}
      {/* 순서변경 삽입 위치 — 화면좌표(fixed) 흰 세로선 */}
      {line && (
        <div className="sl-reftray-line" style={{ left: line.x, top: line.y, height: line.h }} />
      )}
    </div>
  );
}
