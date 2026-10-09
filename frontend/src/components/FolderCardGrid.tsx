// 공유 & 리뷰 탭의 폴더 묶음 보기 — 고른 폴더 바로 아래 폴더마다 카드 한 장(표지·이름·건수).
//  표지는 팀이 정한 대표, 없으면 가장 최근 것(그때는 카드 위에 '대표 미정'). 한 장짜리 카드와 구분되게 종이를 겹친 모양이다.
//  한 번 클릭 = 고르기(Ctrl·⌘ 토글, Shift 범위, 빈 곳에서 끌면 걸친 카드 모두), 휠 클릭 = 컷 정보(Jay 2026-10-08).
//  두 번 클릭 = 그 폴더에 하위 폴더가 있으면(에피소드) 그 폴더로 **들어가고**(사이드바에서 그 폴더를 누른 것과 같다), 없으면(컷)
//  그 폴더의 창(Jay 2026-10-09 '가. 들어가기'). 끌기·클릭 판정은 ThumbnailGrid 와 같은 식(5px 안 움직이면 클릭, 마퀴는 lib/marquee).
//  S 단추·작성자 표시는 넣지 않는다 — 이 카드는 생성물 한 장이 아니라 묶음이다.
import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../lib/i18n";
import { computeMarquee, marqueeHits, type MarqueeRect } from "../lib/marquee";
import { thumbOf } from "../lib/media";
import { addWindowMouseDrag, removeWindowMouseDrag } from "../lib/windowDrag";
import type { FolderCard } from "../types";
import { MediaThumbnail } from "./MediaThumbnail";

interface Props {
  folders: FolderCard[];
  scale: number; // 라이브러리 격자와 같은 카드 크기 배율
  fill: boolean; // 썸네일 꽉 채움 ↔ 비율 유지
  selected: ReadonlySet<string>; // 고른 카드(폴더 경로)
  onSelect: (next: Set<string>) => void;
  onOpen: (folder: FolderCard) => void; // 두 번 클릭(하위 폴더 없음) — 그 폴더의 창
  onEnter: (folder: FolderCard) => void; // 두 번 클릭(하위 폴더 있음) — 그 폴더로 들어가기
  onInfo: (folder: FolderCard, x: number, y: number) => void; // 휠 클릭 — 컷 정보
  top: boolean; // 프로젝트 맨 위(에피소드 단계)인가 — '컷 밖' 대신 '에피소드 밖'
  outside: number; // 고른 폴더에 직접 든 수 — 어느 카드에도 들지 않아 맨 끝 칸으로 알린다
  onShowAll: () => void; // 그 칸을 누르면 한 장씩 보기로
}

interface Drag {
  x: number;
  y: number;
  path: string | null; // 카드 위에서 시작했으면 그 카드, 빈 곳이면 null(마퀴)
  additive: boolean; // Ctrl·⌘
  range: boolean; // Shift
  base: Set<string>; // 시작 때 고른 것
  moved: boolean;
}

export function FolderCardGrid({ folders, scale, fill, selected, onSelect, onOpen, onEnter, onInfo, top, outside, onShowAll }: Props) {
  const t = useT();
  const width = Math.round(180 * scale); // ThumbnailGrid 의 카드 최소 폭과 같은 식
  const thumbSize = width * (window.devicePixelRatio || 1) <= 256 ? 256 : 512;
  const gridRef = useRef<HTMLDivElement>(null);
  const [marquee, setMarquee] = useState<MarqueeRect | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const anchorRef = useRef<string | null>(null); // Shift 범위의 시작 = 마지막으로 누른 카드
  // 최신 props 를 ref 로 — 창 전역 리스너가 낡은 값을 잡지 않게.
  const opsRef = useRef({ folders, selected, onSelect });
  opsRef.current = { folders, selected, onSelect };
  const rafRef = useRef<number | null>(null);
  const lastMoveRef = useRef<MouseEvent | null>(null);

  // 마퀴 히트 계산은 프레임당 한 번(ThumbnailGrid 와 같다).
  const flushMarquee = useCallback(() => {
    rafRef.current = null;
    const e = lastMoveRef.current;
    const d = dragRef.current;
    const grid = gridRef.current;
    if (!e || !d || !grid) return;
    const { rect, b } = computeMarquee(grid, d, e);
    setMarquee(rect);
    const base = d.additive || d.range ? d.base : [];
    opsRef.current.onSelect(marqueeHits<string>(grid, ".cut-card[data-path]", b, base, (el) => el.dataset.path || null));
  }, []);
  // 카드 위에서 시작한 끌기도 마퀴다 — 카드가 꽉 찬 격자에는 빈 곳이 없어 달리 시작할 데가 없다(10-09 실측: 100장에서 0장 고름).
  //  생성물 카드와 달리 컷 카드에는 끌어 놓을 데(프롬프트 재사용)가 없어 겹칠 것이 없다. 5px 안이면 클릭.
  const onDragMove = useCallback((e: MouseEvent) => {
    const d = dragRef.current;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5) return;
    d.moved = true;
    lastMoveRef.current = e;
    if (rafRef.current == null) rafRef.current = requestAnimationFrame(flushMarquee);
  }, [flushMarquee]);
  // 끝 — mouseup 이면 클릭 판정, 창을 떠나서(blur) 끝났으면 버린다(Alt+Tab 뒤 돌아온 움직임이 고르기로 이어지지 않게).
  const endDragRef = useRef<(e?: Event) => void>(() => {});
  const onDragEnd = useCallback((e?: Event) => endDragRef.current(e), []);
  endDragRef.current = (e?: Event) => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      // 마지막 움직임의 계산이 아직 안 돌았으면 지금 돌린다 — 놓는 순간의 선택이 버려지지 않게(Codex 코드 리뷰). 창을 떠난 것은 버린다.
      if (e?.type !== "blur") flushMarquee();
    }
    const d = dragRef.current;
    dragRef.current = null;
    removeWindowMouseDrag(onDragMove, onDragEnd);
    window.removeEventListener("blur", onDragEnd);
    setMarquee(null);
    if (!d || d.moved || e?.type === "blur") return;
    const { folders: list, onSelect: select } = opsRef.current;
    if (d.path) {
      const anchor = anchorRef.current;
      const from = anchor === null ? -1 : list.findIndex((folder) => folder.path === anchor);
      const to = list.findIndex((folder) => folder.path === d.path);
      if (d.range && from >= 0 && to >= 0) {
        // Shift = 마지막으로 누른 카드~여기(격자 순서). 시작은 그대로 둔다 — 이어서 Shift 로 범위를 고친다.
        const [lo, hi] = from < to ? [from, to] : [to, from];
        select(new Set(list.slice(lo, hi + 1).map((folder) => folder.path)));
        return;
      }
      anchorRef.current = d.path;
      if (d.additive) {
        const next = new Set(d.base);
        if (next.has(d.path)) next.delete(d.path);
        else next.add(d.path);
        select(next);
      } else select(new Set([d.path]));
    } else if (!d.additive && !d.range) select(new Set());
  };
  // 언마운트(폴더 창이 열리며 격자가 사라지는 등) — 누르고 있던 끌기를 버린다(ThumbnailGrid 와 같은 이유).
  useEffect(() => () => {
    dragRef.current = null;
    removeWindowMouseDrag(onDragMove, onDragEnd);
    window.removeEventListener("blur", onDragEnd);
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
  }, [onDragMove, onDragEnd]);

  const onGridMouseDown = (e: React.MouseEvent) => {
    if (e.button === 1) {
      e.preventDefault(); // 휠 클릭의 자동 스크롤 막기(정보는 카드의 auxclick)
      return;
    }
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest(".cut-out")) return; // '컷 밖' 칸은 고르는 대상이 아니다(누르면 한 장씩 보기)
    const card = target.closest(".cut-card[data-path]") as HTMLElement | null;
    e.preventDefault(); // 끌 때 글자·그림이 긁히지 않게(카드 위에서 시작해도 마퀴)
    gridRef.current?.focus();
    dragRef.current = {
      x: e.clientX, y: e.clientY, path: card?.dataset.path ?? null,
      additive: e.ctrlKey || e.metaKey, range: e.shiftKey, base: new Set(opsRef.current.selected), moved: false,
    };
    addWindowMouseDrag(onDragMove, onDragEnd);
    window.addEventListener("blur", onDragEnd);
  };

  return (
    <div className="grid-wrap">
      {/* tabIndex — 폴더 창을 닫은 뒤 초점을 돌려받는 자리(App 의 초점 복원) */}
      <div
        className="cut-grid"
        ref={gridRef}
        tabIndex={-1}
        style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${width}px, 1fr))` }}
        onMouseDown={onGridMouseDown}
      >
        {folders.map((folder) => {
          const asset = folder.cover.assets?.[0];
          const isVideo = asset?.type === "video";
          const isSelected = selected.has(folder.path);
          const subfolders = folder.subfolders ?? 0;
          return (
            <button
              key={folder.path}
              type="button"
              data-path={folder.path}
              className={"cut-card" + (isSelected ? " sel" : "")}
              aria-pressed={isSelected}
              title={`${folder.path} · ${subfolders ? `${t("컷")} ${subfolders} · ` : ""}${folder.count}${t("건")}`}
              onDoubleClick={() => (subfolders ? onEnter(folder) : onOpen(folder))}
              onAuxClick={(e) => {
                if (e.button !== 1) return;
                e.preventDefault();
                if (!isSelected) onSelect(new Set([folder.path]));
                onInfo(folder, e.clientX, e.clientY);
              }}
            >
              <span className={"cut-face" + (fill ? "" : " contain")}>
                {/* 생성물 카드와 같은 그림 분기(깨진 뒤 새 대표로 바뀌면 다시 보이고, 포스터 없는 영상은 첫 프레임) */}
                <MediaThumbnail
                  thumb={thumbOf(folder.cover, thumbSize)}
                  isVideo={isVideo}
                  src={asset?.file_path}
                  alt=""
                  fallback={null}
                />
                {isVideo && <span className="play-badge">▶</span>}
                <span className="cut-tab">
                  <span>{folder.name}</span>
                  {subfolders > 0 && <em>{t("컷")} {subfolders} ·</em>}
                  <b>{folder.count}</b>
                </span>
              </span>
              {!folder.rep && <span className="cut-pill">{t("대표 미정")}</span>}
            </button>
          );
        })}
        {outside > 0 && (
          <button
            type="button"
            className="cut-card cut-out"
            title={t("이 폴더에 직접 든 생성물은 컷 카드에 들지 않습니다 — 누르면 한 장씩 모두 봅니다")}
            onClick={onShowAll}
          >
            <span className="cut-out-count">{t(top ? "에피소드 밖" : "컷 밖")} {outside}{t("건")}</span>
            <span className="cut-out-hint">{t("한 장씩 보기")}</span>
          </button>
        )}
        {marquee && (
          <div
            className="assets-marquee"
            style={{ left: marquee.l, top: marquee.t, width: marquee.w, height: marquee.h }}
          />
        )}
      </div>
    </div>
  );
}
