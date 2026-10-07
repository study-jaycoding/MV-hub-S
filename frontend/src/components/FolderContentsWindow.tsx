// 카드의 폴더 이름표를 누르면 뜨는 '폴더의 생성물' 창 — 그 폴더(하위 포함)에 무엇이 있는지 본다.
// 뒤의 목록은 그대로 둔다: 창이 자기 목록을 따로 조회한다(useFolderContents). 껍데기는 캔버스 '폴더 보기' 창(.folder-peek)과 같다.
// 창 안은 보기 전용 타일 — 더블클릭(키보드는 Enter·Space) = 크게 보기. 선택·컬러·태그는 사이드바 폴더 필터로 본 목록에서 한다.
import { useEffect, useRef } from "react";
import { APP_EVENTS } from "../lib/appEvents";
import { folderFullLabel } from "../lib/folderLabel";
import { previewTargetFromGenerations } from "../lib/generationGrid";
import { TEAM_SCOPE } from "../lib/generationViews";
import type { LibraryWorkspaceFilter } from "../lib/libraryWorkspaceScope";
import { thumbOf } from "../lib/media";
import { useCustomEvent } from "../lib/useCustomEvent";
import { useEscapeClose } from "../lib/useEscapeClose";
import { useFolderContents, type FolderTarget } from "../lib/useFolderContents";
import type { Generation, PreviewTarget } from "../types";
import { MediaThumbnail } from "./MediaThumbnail";

const TILE_THUMB = 256; // 타일 썸네일 폭 — 크게 보기에 같은 값을 넘겨 자리 표시가 캐시에서 뜨게

export interface FolderWindowTarget extends FolderTarget {
  genId: string; // 누른 카드 — 목록에 있으면 강조
  projectName: string;
}

interface Props {
  target: FolderWindowTarget;
  workspace: LibraryWorkspaceFilter;
  ready: boolean; // 계정·워크스페이스 범위가 정해졌나
  covered: boolean; // 크게 보기·정보 창이 위에 떠 있다 — Esc 와 초점을 그쪽에 양보
  onPreview: (target: PreviewTarget) => void; // 좌우 이동은 창의 목록(연 시점에 불러온 것)으로
  onClose: () => void;
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function FolderContentsWindow({ target, workspace, ready, covered, onPreview, onClose }: Props) {
  const { rows, loading, loadingMore, hasMore, error, loadMore, reload } = useFolderContents(target, workspace, ready);
  const ref = useRef<HTMLElement>(null);

  // 닫힐 때 초점을 열기 전 자리로 돌려준다. 돌려줄 곳이 사라졌으면(가상 목록이 그 카드를 내렸으면) 본 격자로.
  // (아래 효과가 초점을 창으로 옮기기 **전에** 먼저 실행돼 열기 전 자리를 기억한다 — 순서를 바꾸지 말 것.)
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    return () => {
      const back = before?.isConnected ? before : document.querySelector<HTMLElement>(".gen-grid");
      back?.focus?.({ preventScroll: true });
    };
  }, []);
  // 열릴 때, 그리고 위에 떴던 크게 보기·정보 창이 닫힐 때 초점을 창으로.
  useEffect(() => {
    if (!covered && !ref.current?.contains(document.activeElement)) ref.current?.focus({ preventScroll: true });
  }, [covered]);
  // 초점이 창 밖에 있을 때의 Esc(창 안은 아래 onKeyDown 이 먼저 받는다).
  useEscapeClose(onClose, !covered);
  // 크게 보기의 [부분 수정]으로 넘어가면 창을 닫는다 — 크게 보기가 닫히며 초점이 이 창으로 돌아와 부분 수정 창 뒤에서
  // Tab 을 가두고, 부분 수정의 Esc 가 이 창까지 닫는다(코덱스 코드 리뷰). 부분 수정은 이 창 위에서 이어 갈 작업이 아니다.
  useCustomEvent(APP_EVENTS.partialEdit, onClose);

  const openPreview = (gen: Generation) => {
    const preview = previewTargetFromGenerations(rows, gen, TILE_THUMB);
    // 공유 & 리뷰에서 연 것은 그 칸(@team)에 '마지막으로 본' 을 남긴다 — 카드에서 직접 열 때와 같게.
    if (preview) onPreview(target.tab === "team" ? { ...preview, sceneId: TEAM_SCOPE } : preview);
  };
  const title = folderFullLabel(target.projectName, target.path);
  return (
    <>
      <div className="folder-peek-catcher folder-contents-catcher" onMouseDown={onClose} />
      <section
        ref={ref}
        className="folder-peek folder-contents"
        role="dialog"
        aria-modal="true"
        aria-label={`${title} 폴더의 생성물`}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (covered) return; // 위 창이 받는다
          // 창 안 키는 뒤 화면의 단축키(선택 해제·색·코멘트 등)로 새지 않는다.
          e.stopPropagation();
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
            return;
          }
          if (e.key !== "Tab") return;
          const items = [...(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
          if (items.length === 0) {
            e.preventDefault();
            return;
          }
          const first = items[0];
          const last = items[items.length - 1];
          const active = document.activeElement;
          if (e.shiftKey ? active === first || active === ref.current : active === last) {
            e.preventDefault();
            (e.shiftKey ? last : first).focus();
          }
        }}
      >
        <header className="folder-peek-hd">
          <span className="folder-peek-title" title={title}>
            {title}
          </span>
          <span className="folder-peek-count">
            {loading ? "…" : `${rows.length}${hasMore ? "+" : ""}개`}
          </span>
          <button type="button" className="folder-peek-x" onClick={onClose} title="닫기 (Esc)">
            ✕
          </button>
        </header>
        <div className="fc-body">
          {loading && <div className="fc-note">불러오는 중…</div>}
          {!loading && rows.length === 0 && error && (
            <div className="fc-note fc-error">
              {error}
              <button type="button" className="fc-btn" onClick={reload}>
                다시 시도
              </button>
            </div>
          )}
          {!loading && rows.length === 0 && !error && <div className="fc-note">이 폴더에 보이는 생성물이 없습니다.</div>}
          {rows.length > 0 && (
            <div className="fc-grid">
              {rows.map((g) => (
                <FolderTile key={g.id} gen={g} here={g.id === target.genId} onOpen={() => openPreview(g)} />
              ))}
            </div>
          )}
          {rows.length > 0 && error && <div className="fc-note fc-error">{error}</div>}
          {hasMore && (
            <button type="button" className="fc-btn fc-more" disabled={loadingMore} onClick={() => void loadMore()}>
              {loadingMore ? "불러오는 중…" : "더 보기"}
            </button>
          )}
        </div>
        <footer className="fc-foot">더블클릭 = 크게 보기 · Esc = 닫기</footer>
      </section>
    </>
  );
}

function FolderTile({ gen, here, onOpen }: { gen: Generation; here: boolean; onOpen: () => void }) {
  const asset = gen.assets?.[0];
  const isVideo = asset?.type === "video";
  return (
    <button
      type="button"
      className={"fc-tile" + (here ? " here" : "")}
      title={(gen.prompt ?? "").slice(0, 80) || "(제목 없음)"}
      onDoubleClick={onOpen}
      // 키보드(Enter·Space)와 보조기술의 누름은 detail 0 인 click 으로 온다 — 그것도 연다. 마우스 한 번 클릭(detail 1)은 초점만.
      onClick={(e) => {
        if (e.detail === 0) onOpen();
      }}
    >
      <MediaThumbnail
        thumb={asset ? thumbOf(gen, TILE_THUMB) : null}
        isVideo={isVideo}
        src={asset?.file_path}
        fallback={<span className="fc-noimg">미리보기 없음</span>}
      />
      {isVideo && <span className="play-badge">▶</span>}
      {(gen.is_final || gen.shared) && (
        <span className={"fc-mark" + (gen.is_final ? " final" : "")} title={gen.is_final ? "최종" : "팀에 공유됨"}>
          {gen.is_final ? "★" : "S"}
        </span>
      )}
      {!gen.is_mine && <span className="creator-badge">👤 {gen.creator_name || "팀원"}</span>}
      {here && <span className="fc-here">방금 누른 카드</span>}
    </button>
  );
}
